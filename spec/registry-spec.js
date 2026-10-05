const path = require("path");
const { Emitter, Point, Range } = require("lumine");
const temp = require("@lumine-code/fs-temp");

const Registry = require("../lib/registry");
const ProviderBroker = require("../lib/provider-broker");

function makeProvider(overrides = {}) {
  return {
    packageName: "symbol-provider-stub",
    name: "Stub",
    score() {
      return true;
    },
    async getDocumentSymbolSources(editor) {
      const score = Number(await this.score(editor));
      return [
        {
          id: this.packageName,
          name: this.name,
          shortLabel: "SP",
          score,
          state: score > 0 ? "ready" : "unavailable",
        },
      ];
    },
    getDocumentSymbols() {
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
      getDocumentSymbols() {
        calls++;
        return new Promise((resolve) => (resolveSymbols = resolve));
      },
    });
    registry.addDocumentProviders(provider);

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
    spyOn(provider, "getDocumentSymbols").and.callThrough();
    expect(await registry.getFileSymbols(editor)).toBe(a);
    expect(provider.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("shares one provider run between flat and tree requests", async () => {
    let calls = 0;
    let resolveSymbols;
    registry.addDocumentProviders(
      makeProvider({
        getDocumentSymbols() {
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
    registry.addDocumentProviders(makeProvider());
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
      getDocumentSymbols: () => [
        { name: "Outer", position: [0, 0] },
        { name: "inner", context: "Outer", position: [2, 0] },
      ],
    });
    registry.addDocumentProviders(provider);

    let tree = await registry.getFileSymbolTree(editor);
    expect(tree[0].children[0].name).toBe("inner");
    expect(tree[0].range.isEmpty()).toBe(true);

    registry.invalidateEditor(editor);
    provider.getDocumentSymbols = jasmine.createSpy("getDocumentSymbols").and.returnValue([]);
    expect(await registry.getFileSymbols(editor)).toEqual([]);
    expect(await registry.getFileSymbolTree(editor)).toEqual([]);
    expect(provider.getDocumentSymbols).toHaveBeenCalledTimes(1);
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
      getDocumentSymbols(_editor, request) {
        return new Promise((resolve) => {
          request.signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
    });
    registry.addDocumentProviders(provider);

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

  for (const outcome of ["rejects a stale projection", "returns stale symbols"]) {
    it(`aborts on the first text edit when a provider ${outcome}`, async () => {
      const buffer = editor.getBuffer();
      // Drive the idle event explicitly so the response settles while the
      // buffer is still changing, regardless of the test machine's speed.
      spyOn(buffer, "debouncedEmitDidStopChangingEvent");
      spyOn(console, "error");
      let providerSignal, resolveSymbols, rejectSymbols;
      const provider = makeProvider({
        getDocumentSymbols(_editor, { signal }) {
          providerSignal = signal;
          return new Promise((resolve, reject) => {
            resolveSymbols = resolve;
            rejectSymbols = reject;
          });
        },
      });
      registry.addDocumentProviders(provider);
      const events = [];
      registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));

      const pending = registry.getFileSymbols(editor);
      await conditionPromise(() => resolveSymbols);
      buffer.append("updated");

      expect(providerSignal.aborted).toBe(true);
      expect(events).toEqual([]);
      if (outcome === "rejects a stale projection") {
        rejectSymbols(Object.assign(new Error("projection changed"), { code: "PROJECTION_STALE" }));
      } else {
        resolveSymbols([{ name: "stale", position: new Point(0, 0) }]);
      }
      expect(await pending).toBeNull();
      expect(registry.peekFileSymbols(editor)).toBeNull();
      expect(registry.inflight.has(editor)).toBe(false);
      expect(console.error).not.toHaveBeenCalled();
      expect(events).toEqual([]);

      buffer.emitDidStopChangingEvent();
      expect(events).toEqual([{ editor, provider: null }]);
      spyOn(provider, "getDocumentSymbols").and.callFake((currentEditor) => [
        { name: currentEditor.getText(), position: new Point(0, 0) },
      ]);
      const current = await registry.getFileSymbols(editor);
      expect(current.map(({ name }) => name)).toEqual(["updated"]);
      expect(registry.peekFileSymbols(editor)).toBe(current);
      expect(await registry.getFileSymbols(editor)).toBe(current);
      expect(provider.getDocumentSymbols).toHaveBeenCalledTimes(1);
    });
  }

  it("cancels pending provider selection on a text edit before requesting symbols", async () => {
    const buffer = editor.getBuffer();
    spyOn(buffer, "debouncedEmitDidStopChangingEvent");
    let resolveCapability;
    const provider = makeProvider({
      score: () => new Promise((resolve) => (resolveCapability = resolve)),
    });
    spyOn(provider, "getDocumentSymbols").and.callThrough();
    registry.addDocumentProviders(provider);

    const pending = registry.getFileSymbols(editor);
    await conditionPromise(() => resolveCapability);
    buffer.append("updated");
    resolveCapability(true);

    expect(await pending).toBeNull();
    expect(provider.getDocumentSymbols).not.toHaveBeenCalled();
    expect(registry.peekFileSymbols(editor)).toBeNull();

    buffer.emitDidStopChangingEvent();
    spyOn(provider, "score").and.returnValue(true);
    const current = await registry.getFileSymbols(editor);
    expect(current.map(({ name }) => name)).toEqual(["one"]);
    expect(registry.peekFileSymbols(editor)).toBe(current);
    expect(provider.getDocumentSymbols).toHaveBeenCalledTimes(1);
  });

  it("invalidates on save through the editor wiring", async () => {
    registry.addDocumentProviders(makeProvider());
    await registry.getFileSymbols(editor);
    expect(registry.peekFileSymbols(editor)).not.toBeNull();

    let events = [];
    registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));
    await editor.saveAs(path.join(temp.mkdirSync("symbol-registry-"), "sample.txt"));

    expect(registry.peekFileSymbols(editor)).toBeNull();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((bundle) => bundle.editor === editor)).toBe(true);
  });

  it("replaces a removed chosen provider with the next contender", async () => {
    let first = makeProvider({
      packageName: "first",
      name: "First",
      score: () => 1,
      getDocumentSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    let second = makeProvider({
      packageName: "second",
      name: "Second",
      score: () => 0.5,
      getDocumentSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addDocumentProviders(first, second);
    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual(["first"]);

    registry.removeDocumentProviders(first);

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("replaces the cached chosen when a stronger contender arrives", async () => {
    let first = makeProvider({
      packageName: "first",
      name: "First",
      score: () => 0.5,
      getDocumentSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    registry.addDocumentProviders(first);
    await registry.getFileSymbols(editor);

    let second = makeProvider({
      packageName: "second",
      name: "Second",
      score: () => 1,
      getDocumentSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addDocumentProviders(second);

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("reselects the chosen winner after its own invalidation", async () => {
    let emitter = new Emitter();
    let firstScore = 1;
    let first = makeProvider({
      packageName: "first",
      name: "First",
      score: () => firstScore,
      onDidInvalidateDocumentSymbols: (callback) => emitter.on("clear", callback),
      getDocumentSymbols: () => [{ name: "first", position: new Point(0, 0) }],
    });
    let second = makeProvider({
      packageName: "second",
      name: "Second",
      score: () => 0.5,
      getDocumentSymbols: () => [{ name: "second", position: new Point(0, 0) }],
    });
    registry.addDocumentProviders(first, second);
    await registry.getFileSymbols(editor);

    firstScore = 0;
    emitter.emit("clear", { editor });

    expect((await registry.getFileSymbols(editor)).map((symbol) => symbol.name)).toEqual([
      "second",
    ]);
  });

  it("does not cache a provider failure as an empty file", async () => {
    let fail = true;
    const provider = makeProvider({
      getDocumentSymbols() {
        if (fail) throw new Error("server document is not ready");
        return [{ name: "recovered", position: new Point(2, 0) }];
      },
    });
    registry.addDocumentProviders(provider);
    spyOn(console, "error");

    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(registry.peekFileSymbols(editor)).toBeNull();
    fail = false;
    expect((await registry.getFileSymbols(editor)).map(({ name }) => name)).toEqual(["recovered"]);
  });

  it("derives a position for range-only symbols and sorts file results", async () => {
    registry.addDocumentProviders(
      makeProvider({
        getDocumentSymbols: () => [
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
    registry.addDocumentProviders(
      makeProvider({
        getDocumentSymbols: () => [
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

  it("drops editor state and listeners when the editor is destroyed", async () => {
    registry.addDocumentProviders(makeProvider());
    await registry.getFileSymbols(editor);
    expect(registry.editorSubscriptions.has(editor)).toBe(true);
    expect(registry.cache.has(editor)).toBe(true);

    editor.destroy();

    expect(registry.editorSubscriptions.has(editor)).toBe(false);
    expect(registry.cache.has(editor)).toBe(false);
    expect(registry.stale.has(editor)).toBe(false);
    expect(registry.inflight.has(editor)).toBe(false);
  });

  it("stops listening to a removed provider's cache-clear events", async () => {
    let emitter = new Emitter();
    let provider = makeProvider({
      onDidInvalidateDocumentSymbols: (callback) => emitter.on("clear", callback),
    });
    registry.addDocumentProviders(provider);
    registry.removeDocumentProviders(provider);

    let events = [];
    registry.onDidInvalidateFileSymbols((bundle) => events.push(bundle));
    emitter.emit("clear", { editor });
    expect(events.length).toBe(0);
  });

  it("is inert after destroy", async () => {
    registry.addDocumentProviders(makeProvider());
    await registry.getFileSymbols(editor);
    registry.destroy();
    expect(registry.editorSubscriptions.size).toBe(0);
    expect(registry.cache.size).toBe(0);
    expect(registry.stale.size).toBe(0);
    expect(registry.inflight.size).toBe(0);
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(await registry.searchWorkspace("que")).toBeNull();
    expect(await registry.findDefinitions(editor)).toBeNull();
  });
});

describe("symbol provider broker selection", () => {
  const editor = { getGrammar: () => ({ scopeName: "text.plain" }) };

  it("keeps provider outcomes aligned when registration changes mid-selection", async () => {
    const broker = new ProviderBroker();
    let answer;
    const first = makeProvider({
      packageName: "first",
      score: () => new Promise((resolve) => (answer = resolve)),
    });
    const second = makeProvider({ packageName: "second" });
    broker.add("document", first);

    const selection = broker.documentSources(editor);
    await conditionPromise(() => answer);
    broker.add("document", second);
    answer(true);

    expect((await selection).map((source) => source.provider)).toEqual([first]);
    broker.destroy();
  });

  it("contains a synchronous score failure", async () => {
    const broker = new ProviderBroker();
    const broken = makeProvider({
      packageName: "broken",
      score() {
        throw new Error("broken provider");
      },
    });
    broker.add("document", broken);
    expect(await broker.documentSources(editor)).toEqual([]);
    broker.destroy();
  });

  it("releases provider subscriptions and references on destroy", () => {
    const broker = new ProviderBroker();
    let emitter = new Emitter();
    let provider = makeProvider({
      onDidInvalidateDocumentSymbols: (callback) => emitter.on("clear", callback),
    });
    broker.add("document", provider);

    broker.destroy();

    expect(broker.subscriptions.document.size).toBe(0);
    expect(broker.providers.document).toEqual([]);
  });
});
