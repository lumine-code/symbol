const path = require("path");
const { Emitter, Point, Range } = require("lumine");
const temp = require("@lumine-code/temp");

const Registry = require("../lib/registry");


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

  it("re-queries only the provider that cleared its own cache", async () => {
    let emitter = new Emitter();
    let a = makeProvider({
      packageName: "prov-a",
      name: "A",
      getSymbols: () => [{ name: "a", position: new Point(0, 0) }],
      onShouldClearCache: (callback) => emitter.on("clear", callback),
    });
    let b = makeProvider({
      packageName: "prov-b",
      name: "B",
      isExclusive: false,
      getSymbols: () => [{ name: "b", position: new Point(1, 0) }],
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
    expect(a.getSymbols).toHaveBeenCalled();
    expect(b.getSymbols).not.toHaveBeenCalled();
    expect(second.map((s) => s.name)).toEqual(["a", "b"]);
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
    expect(await registry.getFileSymbols(editor)).toBeNull();
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
    registry.destroy();
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(await registry.searchProject(editor, "que")).toBeNull();
    expect(await registry.findDeclarations(editor)).toBeNull();
  });
});
