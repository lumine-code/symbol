const path = require("path");
const { Emitter, Point, Range } = require("lumine");
const temp = require("@lumine-code/temp");

const Registry = require("../lib/registry");
const ProviderBroker = require("../lib/provider-broker");

function makeProvider(overrides = {}) {
  return {
    packageName: "symbol-provider-stub",
    name: "Stub",
    isExclusive: true,
    canProvideSymbols() {
      return true;
    },
    getSymbols() {
      return [{ name: "one", position: new Point(0, 0) }];
    },
    ...overrides,
  };
}

describe("symbol registry", () => {
  let registry, editor;

  beforeEach(async () => {
    // The runner freezes timers by default; the registry's timeout budgets
    // and `conditionPromise` polling both need them live.
    jasmine.unspy(Date, "now");
    jasmine.unspy(global, "setTimeout");

    lumine.config.set("symbol.providerTimeout", 1000);
    registry = new Registry();
    editor = await lumine.workspace.open();
  });

  afterEach(() => {
    registry.destroy();
  });

  it("shares one in-flight run and caches the completed result", async () => {
    let calls = 0;
    let resolveSymbols;
    let provider = makeProvider({
      getSymbols() {
        calls++;
        return new Promise((resolve) => (resolveSymbols = resolve));
      },
    });
    registry.addProviders(provider);

    let first = registry.getFileSymbols(editor);
    let second = registry.getFileSymbols(editor);
    await conditionPromise(() => resolveSymbols);
    resolveSymbols([{ name: "one", position: new Point(0, 0) }]);

    let [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.length).toBe(1);
    expect(b).toBe(a);

    // The completed run is cached even though nobody is waiting any more.
    expect(registry.peekFileSymbols(editor)).toBe(a);
    spyOn(provider, "getSymbols").and.callThrough();
    expect(await registry.getFileSymbols(editor)).toBe(a);
    expect(provider.getSymbols).not.toHaveBeenCalled();
  });

  it("shares one provider run between flat and tree requests", async () => {
    let calls = 0;
    let resolveSymbols;
    registry.addProviders(
      makeProvider({
        getSymbols() {
          calls++;
          return new Promise((resolve) => (resolveSymbols = resolve));
        },
      }),
    );

    let flatPromise = registry.getFileSymbols(editor);
    let treePromise = registry.getFileSymbolTree(editor);
    await conditionPromise(() => resolveSymbols);
    resolveSymbols([
      { name: "Outer", tag: "class", range: new Range([0, 0], [10, 0]) },
      {
        name: "inner",
        icon: "book",
        position: new Point(2, 4),
        range: new Range([2, 0], [4, 0]),
      },
    ]);

    let [flat, tree] = await Promise.all([flatPromise, treePromise]);
    expect(calls).toBe(1);
    expect(flat.map((symbol) => symbol.name)).toEqual(["Outer", "inner"]);
    expect(tree.map((symbol) => symbol.name)).toEqual(["Outer"]);
    expect(tree[0].children.map((symbol) => symbol.name)).toEqual(["inner"]);
    expect(tree[0].tag).toBe("class");
    expect(tree[0].children[0].icon).toBe("book");
    expect(registry.peekFileSymbolTree(editor)).toBe(tree);
  });

  it("builds and memoizes the tree only when a tree consumer asks for it", async () => {
    registry.addProviders(makeProvider());
    spyOn(registry, "buildFileSymbolTree").and.callThrough();

    await registry.getFileSymbols(editor);
    expect(registry.buildFileSymbolTree).not.toHaveBeenCalled();

    let first = await registry.getFileSymbolTree(editor);
    let second = registry.peekFileSymbolTree(editor);
    expect(registry.buildFileSymbolTree).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("assembles ordinary lexical hierarchies in linear containment work", () => {
    const count = 1000;
    const symbols = [];
    for (let index = 0; index < count; index++) {
      symbols.push({
        name: `scope-${index}`,
        position: new Point(index, 0),
        range: new Range([index, 0], [count * 2 - index, 0]),
      });
    }
    spyOn(Range.prototype, "containsRange").and.callThrough();

    let tree = registry.buildFileSymbolTree(symbols);

    expect(tree.length).toBe(1);
    expect(Range.prototype.containsRange.calls.count()).toBeLessThan(count * 2);
  });

  it("assembles point-only symbols by context and caches empty results", async () => {
    let provider = makeProvider({
      getSymbols: () => [
        { name: "Outer", position: [0, 0] },
        { name: "inner", context: "Outer", position: [2, 0] },
      ],
    });
    registry.addProviders(provider);

    let tree = await registry.getFileSymbolTree(editor);
    expect(tree[0].children[0].name).toBe("inner");
    expect(tree[0].range.isEmpty()).toBe(true);

    registry.invalidateEditor(editor);
    provider.getSymbols = jasmine.createSpy("getSymbols").and.returnValue([]);
    expect(await registry.getFileSymbols(editor)).toEqual([]);
    expect(await registry.getFileSymbolTree(editor)).toEqual([]);
    expect(provider.getSymbols).toHaveBeenCalledTimes(1);
  });

  it("uses the latest matching name or short name for context", () => {
    let tree = registry.buildFileSymbolTree([
      {
        name: "Old",
        shortName: "Scope",
        position: new Point(0, 0),
        range: new Range([0, 0], [0, 0]),
      },
      {
        name: "Scope",
        position: new Point(1, 0),
        range: new Range([1, 0], [1, 0]),
      },
      {
        name: "child",
        context: "Scope",
        position: new Point(2, 0),
        range: new Range([2, 0], [2, 0]),
      },
    ]);

    expect(tree[0].children).toEqual([]);
    expect(tree[1].children.map((symbol) => symbol.name)).toEqual(["child"]);
  });

  it("preserves equal-range and non-monotonic-range parent semantics", () => {
    let equalTree = registry.buildFileSymbolTree([
      { name: "first", position: new Point(0, 0), range: new Range([0, 0], [10, 0]) },
      { name: "second", position: new Point(0, 0), range: new Range([0, 0], [10, 0]) },
      { name: "child", position: new Point(1, 0), range: new Range([1, 0], [2, 0]) },
    ]);
    expect(equalTree[0].children.map((symbol) => symbol.name)).toEqual(["child"]);
    expect(equalTree[1].children).toEqual([]);

    spyOn(registry, "buildFileSymbolTreeByScan").and.callThrough();
    let irregularTree = registry.buildFileSymbolTree([
      { name: "narrow", position: new Point(0, 0), range: new Range([5, 0], [20, 0]) },
      { name: "wide", position: new Point(1, 0), range: new Range([0, 0], [30, 0]) },
      { name: "child", position: new Point(2, 0), range: new Range([6, 0], [7, 0]) },
    ]);
    expect(registry.buildFileSymbolTreeByScan).toHaveBeenCalledTimes(1);
    expect(irregularTree[0].children.map((symbol) => symbol.name)).toEqual(["child"]);
  });

  it("aborts the in-flight run on invalidation and resolves it null", async () => {
    let provider = makeProvider({
      getSymbols(meta) {
        return new Promise((resolve) => {
          meta.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
    });
    registry.addProviders(provider);

    let events = [];
    registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));

    let promise = registry.getFileSymbols(editor);
    expect(registry.inflight.has(editor)).toBe(true);
    registry.invalidateEditor(editor);

    expect(await promise).toBeNull();
    expect(events.length).toBe(1);
    expect(events[0].editor).toBe(editor);
    expect(events[0].provider).toBeNull();
  });

  it("invalidates on save through the editor wiring", async () => {
    registry.addProviders(makeProvider());
    await registry.getFileSymbols(editor);
    expect(registry.peekFileSymbols(editor)).not.toBeNull();

    let events = [];
    registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));
    await editor.saveAs(path.join(temp.mkdirSync("symbol-registry-"), "sample.txt"));

    expect(registry.peekFileSymbols(editor)).toBeNull();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((bundle) => bundle.editor === editor)).toBe(true);
  });

  it("re-queries only a supplemental provider that cleared its own cache", async () => {
    let emitter = new Emitter();
    let a = makeProvider({
      packageName: "prov-a",
      name: "A",
      getSymbols: () => [{ name: "a", position: new Point(0, 0) }],
    });
    let b = makeProvider({
      packageName: "prov-b",
      name: "B",
      isExclusive: false,
      getSymbols: () => [{ name: "b", position: new Point(1, 0) }],
      onShouldClearCache: (callback) => emitter.on("clear", callback),
    });
    registry.addProviders(a, b);

    let first = await registry.getFileSymbols(editor);
    expect(first.map((s) => s.name)).toEqual(["a", "b"]);

    // A clear scoped to another editor leaves this one's cache alone.
    let other = await lumine.workspace.open();
    emitter.emit("clear", { editor: other });
    expect(registry.peekFileSymbols(editor)).not.toBeNull();

    emitter.emit("clear", { editor });
    expect(registry.peekFileSymbols(editor)).toBeNull();

    spyOn(a, "getSymbols").and.callThrough();
    spyOn(b, "getSymbols").and.callThrough();
    let second = await registry.getFileSymbols(editor);
    expect(a.getSymbols).not.toHaveBeenCalled();
    expect(b.getSymbols).toHaveBeenCalled();
    expect(second.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("selects only a stale supplemental provider", async () => {
    let emitter = new Emitter();
    let exclusive = makeProvider({ packageName: "exclusive", name: "Exclusive" });
    let supplemental = makeProvider({
      packageName: "supplemental",
      name: "Supplemental",
      isExclusive: false,
      onShouldClearCache: (callback) => emitter.on("clear", callback),
      getSymbols: () => [{ name: "extra", position: new Point(1, 0) }],
    });
    registry.addProviders(exclusive, supplemental);
    await registry.getFileSymbols(editor);
    spyOn(exclusive, "canProvideSymbols").and.callThrough();
    spyOn(supplemental, "canProvideSymbols").and.callThrough();

    emitter.emit("clear", { editor });
    await registry.getFileSymbols(editor);

    expect(exclusive.canProvideSymbols).not.toHaveBeenCalled();
    expect(supplemental.canProvideSymbols).toHaveBeenCalledTimes(1);
  });

  it("invalidates providers from the same package independently", async () => {
    let emitter = new Emitter();
    let first = makeProvider({
      packageName: "shared-package",
      name: "First supplemental",
      isExclusive: false,
      onShouldClearCache: (callback) => emitter.on("clear", callback),
      getSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    let second = makeProvider({
      packageName: "shared-package",
      name: "Second supplemental",
      isExclusive: false,
      getSymbols: () => [{ name: "second", position: new Point(1, 0) }],
    });
    registry.addProviders(first, second);
    await registry.getFileSymbols(editor);
    spyOn(first, "getSymbols").and.returnValue([
      { name: "first-refreshed", position: new Point(0, 0) },
    ]);
    spyOn(second, "getSymbols").and.callThrough();

    emitter.emit("clear", { editor });
    let symbols = await registry.getFileSymbols(editor);

    expect(first.getSymbols).toHaveBeenCalledTimes(1);
    expect(second.getSymbols).not.toHaveBeenCalled();
    expect(symbols.map((symbol) => symbol.name)).toEqual(["first-refreshed", "second"]);
  });

  it("replaces a removed exclusive provider with the next contender", async () => {
    let first = makeProvider({
      packageName: "first",
      name: "First",
      canProvideSymbols: () => 1,
      getSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    let second = makeProvider({
      packageName: "second",
      name: "Second",
      canProvideSymbols: () => 0.5,
      getSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addProviders(first, second);
    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual(["first"]);

    registry.removeProviders(first);

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("replaces the cached exclusive when a stronger contender arrives", async () => {
    let first = makeProvider({
      packageName: "first",
      name: "First",
      canProvideSymbols: () => 0.5,
      getSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    registry.addProviders(first);
    await registry.getFileSymbols(editor);

    let second = makeProvider({
      packageName: "second",
      name: "Second",
      canProvideSymbols: () => 1,
      getSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addProviders(second);

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("reselects the exclusive winner after its own invalidation", async () => {
    let emitter = new Emitter();
    let firstScore = 1;
    let first = makeProvider({
      packageName: "first",
      name: "First",
      canProvideSymbols: () => firstScore,
      onShouldClearCache: (callback) => emitter.on("clear", callback),
      getSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    let second = makeProvider({
      packageName: "second",
      name: "Second",
      canProvideSymbols: () => 0.5,
      getSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addProviders(first, second);
    await registry.getFileSymbols(editor);

    firstScore = 0;
    emitter.emit("clear", { editor });

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("marks cached editors stale for a provider that arrives late", async () => {
    let a = makeProvider({
      packageName: "prov-a",
      name: "A",
      getSymbols: () => [{ name: "a", position: new Point(0, 0) }],
    });
    registry.addProviders(a);
    await registry.getFileSymbols(editor);
    expect(registry.peekFileSymbols(editor)).not.toBeNull();

    let b = makeProvider({
      packageName: "prov-b",
      name: "B",
      isExclusive: false,
      getSymbols: () => [{ name: "b", position: new Point(1, 0) }],
    });
    registry.addProviders(b);
    expect(registry.peekFileSymbols(editor)).toBeNull();

    spyOn(a, "getSymbols").and.callThrough();
    spyOn(b, "getSymbols").and.callThrough();
    let symbols = await registry.getFileSymbols(editor);
    expect(a.getSymbols).not.toHaveBeenCalled();
    expect(b.getSymbols).toHaveBeenCalled();
    expect(symbols.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("passes timeoutMs in file metas and omits it elsewhere", async () => {
    let metas = [];
    registry.addProviders(
      makeProvider({
        getSymbols(meta) {
          metas.push(meta);
          return [];
        },
      }),
    );

    await registry.getFileSymbols(editor);
    await registry.searchProject(editor, "que");

    expect(metas[0].type).toBe("file");
    expect(typeof metas[0].timeoutMs).toBe("number");
    expect(metas[1].type).toBe("project");
    expect(metas[1].timeoutMs).toBeUndefined();
    expect(metas[1].query).toBe("que");
  });

  it("hands a list controller only to the exclusive provider", async () => {
    let seen = new Map();
    let exclusive = makeProvider({
      packageName: "prov-exclusive",
      name: "Exclusive",
      getSymbols(meta, listController) {
        seen.set("exclusive", listController);
        // The no-op stand-in must absorb calls without a UI attached.
        listController.set({ loadingMessage: "hi" });
        listController.clear("loadingMessage");
        return [];
      },
    });
    let supplemental = makeProvider({
      packageName: "prov-supplemental",
      name: "Supplemental",
      isExclusive: false,
      getSymbols(meta, listController) {
        seen.set("supplemental", listController);
        return [];
      },
    });
    registry.addProviders(exclusive, supplemental);

    await registry.getFileSymbols(editor);
    expect(seen.get("supplemental")).toBeUndefined();
    expect(typeof seen.get("exclusive").set).toBe("function");

    seen.clear();
    registry.invalidateEditor(editor);
    let controller = { set: jasmine.createSpy("set"), clear: jasmine.createSpy("clear") };
    await registry.getFileSymbols(editor, { listController: controller });
    expect(seen.get("exclusive")).toBe(controller);
  });

  it("exposes descriptors, never raw providers", () => {
    let provider = makeProvider();
    registry.addProviders(provider);
    let [descriptor] = registry.providerDescriptors();
    expect(descriptor).not.toBe(provider);
    expect(descriptor.name).toBe("Stub");
    expect(descriptor.packageName).toBe("symbol-provider-stub");
    expect(descriptor.isExclusive).toBe(true);
    expect(descriptor.getSymbols).toBeUndefined();
  });

  it("resolves null when the caller aborts a project search", async () => {
    let started = false;
    registry.addProviders(
      makeProvider({
        getSymbols(meta) {
          started = true;
          return new Promise((resolve) => {
            meta.signal.addEventListener("abort", () => resolve(null), { once: true });
          });
        },
      }),
    );

    let controller = new AbortController();
    let promise = registry.searchProject(editor, "que", { signal: controller.signal });
    await conditionPromise(() => started);
    controller.abort();
    expect(await promise).toBeNull();
  });

  it("builds the project-find meta from the range", async () => {
    editor.setText("alpha beta\n");
    let metas = [];
    registry.addProviders(
      makeProvider({
        getSymbols(meta) {
          metas.push(meta);
          return [];
        },
      }),
    );

    await registry.findDeclarations(editor, { range: new Range([0, 0], [0, 5]) });
    expect(metas[0].type).toBe("project-find");
    expect(metas[0].query).toBe("alpha");
    expect(Array.isArray(metas[0].paths)).toBe(true);
  });

  it("resolves null for a file request no provider can serve", async () => {
    spyOn(registry.broker, "select").and.callThrough();
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(registry.broker.select).toHaveBeenCalledTimes(1);
  });

  it("derives a position for range-only symbols and sorts file results", async () => {
    registry.addProviders(
      makeProvider({
        getSymbols: () => [
          { name: "later", range: new Range([5, 0], [5, 4]) },
          { name: "earlier", position: new Point(1, 0) },
        ],
      }),
    );

    let symbols = await registry.getFileSymbols(editor);
    expect(symbols.map((s) => s.name)).toEqual(["earlier", "later"]);
    expect(symbols[1].position.isEqual(new Point(5, 0))).toBe(true);
    expect(symbols[0].providerId).toBe("symbol-provider-stub");
  });

  it("accepts Point/Range-compatible spellings and normalizes to instances", async () => {
    let warnings = spyOn(console, "warn");
    registry.addProviders(
      makeProvider({
        getSymbols: () => [
          // The spellings a provider that does not share this window's
          // `Point` class sends — ide-client's contract uses arrays.
          { name: "array", position: [2, 4] },
          { name: "object", position: { row: 1, column: 0 } },
          {
            name: "array-range",
            range: [
              [3, 0],
              [3, 5],
            ],
          },
          // Still rejected: no name, no location, garbage location.
          { position: [0, 0] },
          { name: "nowhere" },
          { name: "garbage", position: { line: 5 } },
        ],
      }),
    );

    let symbols = await registry.getFileSymbols(editor);
    expect(symbols.map((s) => s.name)).toEqual(["object", "array", "array-range"]);
    for (let symbol of symbols) expect(symbol.position instanceof Point).toBe(true);
    for (let symbol of symbols) expect(symbol.range instanceof Range).toBe(true);
    expect(symbols[1].position.isEqual(new Point(2, 4))).toBe(true);
    expect(symbols[2].range instanceof Range).toBe(true);
    expect(symbols[2].position.isEqual(new Point(3, 0))).toBe(true);
    expect(warnings).toHaveBeenCalledTimes(3);
  });

  it("parses each repeated project path once per provider run", async () => {
    let parse = spyOn(path, "parse").and.callThrough();
    let file = path.join("project", "same.js");
    registry.addProviders(
      makeProvider({
        getSymbols: () => [
          { name: "one", position: [0, 0], path: file },
          { name: "two", position: [1, 0], path: file },
        ],
      }),
    );

    await registry.searchProject(editor, "");

    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("drops editor state and listeners when the editor is destroyed", async () => {
    registry.addProviders(makeProvider());
    await registry.getFileSymbols(editor);
    expect(registry.editorSubscriptions.has(editor)).toBe(true);
    expect(registry.cache.has(editor)).toBe(true);

    editor.destroy();

    expect(registry.editorSubscriptions.has(editor)).toBe(false);
    expect(registry.cache.has(editor)).toBe(false);
    expect(registry.invalidatedProviders.has(editor)).toBe(false);
    expect(registry.inflight.has(editor)).toBe(false);
  });

  it("stops listening to a removed provider's cache-clear events", async () => {
    let emitter = new Emitter();
    let provider = makeProvider({
      onShouldClearCache: (callback) => emitter.on("clear", callback),
    });
    registry.addProviders(provider);
    registry.removeProviders(provider);

    let events = [];
    registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));
    emitter.emit("clear", { editor });
    expect(events.length).toBe(0);
  });

  it("is inert after destroy", async () => {
    registry.addProviders(makeProvider());
    await registry.getFileSymbols(editor);
    registry.destroy();
    expect(registry.editorSubscriptions.size).toBe(0);
    expect(registry.cache.size).toBe(0);
    expect(registry.invalidatedProviders.size).toBe(0);
    expect(registry.inflight.size).toBe(0);
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(await registry.searchProject(editor, "que")).toBeNull();
    expect(await registry.findDeclarations(editor)).toBeNull();
  });
});

describe("symbol provider broker selection", () => {
  const editor = { getGrammar: () => ({ scopeName: "text.plain" }) };

  it("keeps provider outcomes aligned when registration changes mid-selection", async () => {
    const broker = new ProviderBroker();
    let answer;
    const first = makeProvider({
      packageName: "first",
      canProvideSymbols: () => new Promise((resolve) => (answer = resolve)),
    });
    const second = makeProvider({ packageName: "second" });
    broker.add(first);

    const selection = broker.select({ type: "file", editor });
    await conditionPromise(() => answer);
    broker.add(second);
    answer(true);

    expect(await selection).toEqual([first]);
    broker.destroy();
  });

  it("contains a synchronous canProvideSymbols failure", async () => {
    const broker = new ProviderBroker();
    const broken = makeProvider({
      packageName: "broken",
      canProvideSymbols() {
        throw new Error("broken provider");
      },
    });
    broker.add(broken);
    expect(await broker.select({ type: "file", editor })).toEqual([]);
    broker.destroy();
  });

  it("shares one capability deadline across all providers", async () => {
    const broker = new ProviderBroker();
    broker.add(
      makeProvider({ packageName: "first" }),
      makeProvider({ packageName: "second" }),
      makeProvider({ packageName: "third" }),
    );
    spyOn(global, "setTimeout").and.callThrough();

    await broker.select({ type: "file", editor });

    expect(global.setTimeout).toHaveBeenCalledTimes(1);
    broker.destroy();
  });

  it("releases provider subscriptions and references on destroy", () => {
    const broker = new ProviderBroker();
    let emitter = new Emitter();
    let provider = makeProvider({
      onShouldClearCache: (callback) => emitter.on("clear", callback),
    });
    broker.add(provider);

    broker.destroy();

    expect(broker.providerSubscriptions.size).toBe(0);
    expect(broker.providers).toEqual([]);
  });
});
