const path = require("path");
const temp = require("@lumine-code/fs-temp");
const { Emitter, Range } = require("lumine");
const Registry = require("../lib/registry");

const documentProvider = (name, score, getDocumentSymbols) => ({
  name,
  packageName: name,
  getDocumentSymbolSources: () => [
    { id: name, name, shortLabel: "SP", score, state: score > 0 ? "ready" : "unavailable" },
  ],
  getDocumentSymbols: jasmine.createSpy("getDocumentSymbols").and.callFake(getDocumentSymbols),
});
const workspaceProvider = (name, searchWorkspaceSymbols) => ({
  name,
  packageName: name,
  searchWorkspaceSymbols: jasmine
    .createSpy("searchWorkspaceSymbols")
    .and.callFake(searchWorkspaceSymbols),
});

describe("separate symbol provider roles", () => {
  let registry, editor, root;
  beforeEach(async () => {
    jasmine.useRealClock();
    root = temp.mkdirSync("symbol-roles-");
    lumine.project.setPaths([root]);
    lumine.config.set("symbol.providerTimeout", 100);
    lumine.config.set("symbol.preferCertainProviders", []);
    registry = new Registry();
    editor = await lumine.workspace.open();
  });
  afterEach(() => registry.destroy());
  const local = (name) => [{ name, position: [0, 0] }];
  const located = (name, extra = {}) => [
    { name, position: [0, 0], path: path.join(root, "source.js"), ...extra },
  ];

  it("chooses LSP over Tree-sitter and never combines document sources", async () => {
    const treeSitter = documentProvider("Tree-sitter", 0.999, () => local("syntax"));
    const lsp = documentProvider("Language Server", 1, () => local("semantic"));
    registry.addDocumentProviders(treeSitter, lsp);
    expect((await registry.getFileSymbols(editor)).map(({ name }) => name)).toEqual(["semantic"]);
    expect(treeSitter.getDocumentSymbols).not.toHaveBeenCalled();
    expect(lsp.getDocumentSymbols).toHaveBeenCalledTimes(1);
  });
  it("honours an explicit provider preference before numerical score", async () => {
    lumine.config.set("symbol.preferCertainProviders", ["Tree-sitter"]);
    registry.addDocumentProviders(
      documentProvider("Language Server", 1, () => local("semantic")),
      documentProvider("Tree-sitter", 0.999, () => local("syntax")),
    );
    expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
  });
  for (const failure of ["throw", "reject", "null", "timeout"]) {
    it(`falls back after a document provider ${failure}`, async () => {
      spyOn(console, "error");
      const first = documentProvider("Language Server", 1, () => {
        if (failure === "throw") throw new Error("server failed");
        if (failure === "reject") return Promise.reject(new Error("server failed"));
        if (failure === "null") return null;
        return new Promise(() => {});
      });
      const fallback = documentProvider("Tree-sitter", 0.999, () => local("syntax"));
      registry.addDocumentProviders(first, fallback);
      expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
      expect(fallback.getDocumentSymbols).toHaveBeenCalledTimes(1);
      if (failure === "timeout")
        expect(first.getDocumentSymbols.calls.first().args[1].signal.aborted).toBe(true);
    });
  }
  it("caches a valid empty answer without invoking fallback", async () => {
    const empty = documentProvider("Language Server", 1, () => []);
    const fallback = documentProvider("Tree-sitter", 0.999, () => local("syntax"));
    registry.addDocumentProviders(empty, fallback);
    expect(await registry.getFileSymbols(editor)).toEqual([]);
    expect(await registry.getFileSymbolTree(editor)).toEqual([]);
    expect(empty.getDocumentSymbols).toHaveBeenCalledTimes(1);
    expect(fallback.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("falls back when a nonempty document response contains only malformed records", async () => {
    spyOn(console, "warn");
    const fallback = documentProvider("Tree-sitter", 0.999, () => local("syntax"));
    registry.addDocumentProviders(
      documentProvider("Language Server", 1, () => [null, { position: [0, 0] }]),
      fallback,
    );
    expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
    expect(fallback.getDocumentSymbols).toHaveBeenCalledTimes(1);
  });

  it("keeps valid records from a mixed response without invoking another document source", async () => {
    spyOn(console, "warn");
    const fallback = documentProvider("Tree-sitter", 0.999, () => local("syntax"));
    registry.addDocumentProviders(
      documentProvider("Language Server", 1, () => [null, { position: [0, 0] }, ...local("valid")]),
      fallback,
    );
    expect((await registry.getFileSymbols(editor)).map(({ name }) => name)).toEqual(["valid"]);
    expect(fallback.getDocumentSymbols).not.toHaveBeenCalled();
  });
  it("never caches a late timed-out response over the chosen fallback", async () => {
    let finish;
    const late = documentProvider(
      "Language Server",
      1,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    registry.addDocumentProviders(
      late,
      documentProvider("Tree-sitter", 0.999, () => local("syntax")),
    );
    const accepted = await registry.getFileSymbols(editor);
    finish(local("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.peekFileSymbols(editor)).toBe(accepted);
    expect(accepted[0].name).toBe("syntax");
  });
  it("invalidates only the named editor and treats null as every document", async () => {
    const emitter = new Emitter();
    const provider = documentProvider("source", 1, () => local("one"));
    provider.onDidInvalidateDocumentSymbols = (callback) => emitter.on("invalidate", callback);
    registry.addDocumentProviders(provider);
    const other = await lumine.workspace.open();
    await registry.getFileSymbols(editor);
    await registry.getFileSymbols(other);
    emitter.emit("invalidate", { editor });
    expect(registry.peekFileSymbols(editor)).toBeNull();
    expect(registry.peekFileSymbols(other)).not.toBeNull();
    emitter.emit("invalidate", { editor: null });
    expect(registry.peekFileSymbols(other)).toBeNull();
  });
  it("does not destroy a package-owned provider when its registration is removed", () => {
    const provider = documentProvider("source", 1, () => []);
    provider.destroy = jasmine.createSpy("destroy");
    registry.addDocumentProviders(provider);
    registry.removeDocumentProviders(provider);
    registry.destroy();
    expect(provider.destroy).not.toHaveBeenCalled();
  });
  it("searches workspace providers without an editor or capability-selection call", async () => {
    const provider = workspaceProvider("workspace", (_query, request) => {
      expect(request.editor).toBeUndefined();
      expect(request.paths).toEqual([root]);
      return located("result");
    });
    spyOn(registry.broker, "select").and.throwError("document selection must not run");
    registry.addWorkspaceProviders(provider);
    editor.destroy();
    const symbols = await registry.searchWorkspace("res");
    expect(symbols[0].name).toBe("result");
    expect(provider.searchWorkspaceSymbols.calls.first().args[0]).toBe("res");
  });
  it("preserves other workspace results and reports a partial failure", async () => {
    spyOn(console, "error");
    registry.addWorkspaceProviders(
      workspaceProvider("good", () => located("good")),
      workspaceProvider("bad", () => Promise.reject(new Error("backend failed"))),
    );
    const onStatus = jasmine.createSpy("status");
    const onSymbols = jasmine.createSpy("symbols");
    expect(
      (await registry.searchWorkspace("", { onStatus, onSymbols })).map(({ name }) => name),
    ).toEqual(["good"]);
    expect(onStatus.calls.mostRecent().args[0]).toEqual({ state: "partial" });
    expect(onSymbols.calls.mostRecent().args[0][0].name).toBe("good");
  });
  it("deduplicates the same location while keeping different notebook cells and URIs", async () => {
    const cell = (index) => ({
      name: "same",
      path: path.join(root, "book.ipynb"),
      uri: `vscode-notebook-cell:/book#${index}`,
      cell: index,
      position: [0, 0],
    });
    registry.addWorkspaceProviders(
      workspaceProvider("one", () => [
        cell(1),
        cell(2),
        { name: "remote", uri: "custom:/a", position: [0, 0] },
      ]),
      workspaceProvider("two", () => [
        cell(1),
        { name: "remote", uri: "custom:/b", position: [0, 0] },
      ]),
    );
    const found = await registry.searchWorkspace();
    expect(found.length).toBe(4);
    expect(found.filter(({ cell }) => cell).map(({ cell }) => cell)).toEqual([1, 2]);
    expect(found.filter(({ name }) => name === "remote").map(({ uri }) => uri)).toEqual([
      "custom:/a",
      "custom:/b",
    ]);
  });
  for (const state of ["ready", "unavailable", "starting", "error"]) {
    it(`keeps an empty ${state} workspace response distinguishable`, async () => {
      registry.addWorkspaceProviders(
        workspaceProvider(state, (_query, { onStatus }) => {
          onStatus({ state });
          return [];
        }),
      );
      const onStatus = jasmine.createSpy("status");
      expect(await registry.searchWorkspace("", { onStatus })).toEqual([]);
      expect(onStatus.calls.mostRecent().args[0]).toEqual({ state });
    });
  }
  it("reports unavailable without calling a backend when no project roots exist", async () => {
    const provider = workspaceProvider("workspace", () => located("one"));
    registry.addWorkspaceProviders(provider);
    lumine.project.setPaths([]);
    const onStatus = jasmine.createSpy("status");
    expect(await registry.searchWorkspace("", { onStatus })).toEqual([]);
    expect(onStatus).toHaveBeenCalledWith({ state: "unavailable" });
    expect(provider.searchWorkspaceSymbols).not.toHaveBeenCalled();
  });

  it("reports an invalid nonempty workspace response as an error rather than a ready empty result", async () => {
    spyOn(console, "warn");
    registry.addWorkspaceProviders(workspaceProvider("broken", () => [null, { position: [0, 0] }]));
    const onStatus = jasmine.createSpy("status");
    expect(await registry.searchWorkspace("", { onStatus })).toEqual([]);
    expect(onStatus.calls.mostRecent().args[0]).toEqual({ state: "error" });
  });
  it("suppresses workspace callbacks after completion and after caller cancellation", async () => {
    lumine.config.set("symbol.providerTimeout", 1000);
    let completedRequest;
    registry.addWorkspaceProviders(
      workspaceProvider("source", (_query, request) => {
        completedRequest = request;
        return located("one");
      }),
    );
    const onSymbols = jasmine.createSpy("symbols");
    const onStatus = jasmine.createSpy("status");
    await registry.searchWorkspace("", { onSymbols, onStatus });
    onSymbols.calls.reset();
    onStatus.calls.reset();
    completedRequest.onSymbols(located("late"));
    completedRequest.onStatus({ state: "error" });
    expect(onSymbols).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    let finish, pendingRequest;
    registry.broker.providers.workspace[0].searchWorkspaceSymbols.and.callFake(
      (_query, request) => {
        pendingRequest = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    const controller = new AbortController();
    const pending = registry.searchWorkspace("", {
      signal: controller.signal,
      onSymbols,
      onStatus,
    });
    await conditionPromise(() => finish);
    controller.abort();
    expect(await pending).toBeNull();
    pendingRequest.onSymbols(located("stale"));
    pendingRequest.onStatus({ state: "ready" });
    finish(located("stale"));
    await Promise.resolve();
    expect(onSymbols).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });
  it("exposes role descriptors without provider internals", () => {
    registry.addDocumentProviders(documentProvider("doc", 1, () => []));
    registry.addWorkspaceProviders(workspaceProvider("work", () => []));
    registry.addDefinitionProviders({
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: () => [],
    });
    expect(registry.providerDescriptors()).toEqual([
      { name: "doc", packageName: "doc", role: "document" },
      { name: "work", packageName: "work", role: "workspace" },
      { name: "definition", packageName: "definition", role: "definition" },
    ]);
  });
  it("passes the requested range only to a definition provider", async () => {
    const range = new Range([2, 3], [2, 8]);
    const definition = {
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: jasmine.createSpy("definitions").and.returnValue(located("one")),
    };
    const document = documentProvider("document", 1, () => local("syntax"));
    registry.addDocumentProviders(document);
    registry.addDefinitionProviders(definition);
    expect((await registry.findDefinitions(editor, { range }))[0].name).toBe("one");
    expect(definition.getDefinitions.calls.first().args[0]).toBe(editor);
    expect(definition.getDefinitions.calls.first().args[1].range).toBe(range);
    expect(document.getDocumentSymbols).not.toHaveBeenCalled();
  });
  it("abandons definition replies after the source document changes", async () => {
    let finish, request;
    registry.addDefinitionProviders({
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: (_editor, options) => {
        request = options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = registry.findDefinitions(editor);
    await conditionPromise(() => finish);
    editor.setText("changed");
    expect(request.signal.aborted).toBe(true);
    expect(await pending).toBeNull();
    finish(located("late"));
  });

  it("abandons definition replies after the source path changes", async () => {
    lumine.config.set("symbol.providerTimeout", 1000);
    let finish, request;
    registry.addDefinitionProviders({
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: (_editor, options) => {
        request = options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = registry.findDefinitions(editor);
    await conditionPromise(() => finish);
    editor.getBuffer().setPath(path.join(root, "renamed.js"));
    expect(request.signal.aborted).toBe(true);
    finish(located("old-path"));
    expect(await pending).toBeNull();
  });

  it("withdraws a definition provider removed while its request is running", async () => {
    lumine.config.set("symbol.providerTimeout", 1000);
    let finish, request;
    const provider = {
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: (_editor, options) => {
        request = options;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    };
    registry.addDefinitionProviders(provider);
    const pending = registry.findDefinitions(editor);
    await conditionPromise(() => finish);
    registry.removeDefinitionProviders(provider);
    expect(request.signal.aborted).toBe(true);
    finish(located("removed"));
    expect(await pending).toBeNull();
  });

  it("invalidates workspace requests without cancelling a simultaneous definition lookup", async () => {
    lumine.config.set("symbol.providerTimeout", 1000);
    const emitter = new Emitter();
    let workspaceRequest, finishWorkspace, definitionRequest, finishDefinition;
    const workspace = workspaceProvider("workspace", (_query, request) => {
      workspaceRequest = request;
      return new Promise((resolve) => {
        finishWorkspace = resolve;
      });
    });
    workspace.onDidInvalidateWorkspaceSymbols = (callback) => emitter.on("invalidate", callback);
    registry.addWorkspaceProviders(workspace);
    registry.addDefinitionProviders({
      name: "definition",
      packageName: "definition",
      canProvideDefinitions: () => true,
      getDefinitions: (_editor, request) => {
        definitionRequest = request;
        return new Promise((resolve) => {
          finishDefinition = resolve;
        });
      },
    });
    const workspacePending = registry.searchWorkspace("one");
    const definitionPending = registry.findDefinitions(editor);
    await conditionPromise(() => finishWorkspace && finishDefinition);
    emitter.emit("invalidate");
    expect(workspaceRequest.signal.aborted).toBe(true);
    expect(definitionRequest.signal.aborted).toBe(false);
    expect(await workspacePending).toBeNull();
    finishDefinition(located("definition"));
    expect((await definitionPending)[0].name).toBe("definition");
    finishWorkspace(located("stale"));
  });

  it("retains progressively published workspace results when that backend fails later", async () => {
    spyOn(console, "error");
    registry.addWorkspaceProviders(
      workspaceProvider("partial", (_query, { onSymbols }) => {
        onSymbols(located("available"));
        return Promise.reject(new Error("index stopped"));
      }),
    );
    const onStatus = jasmine.createSpy("status");
    expect((await registry.searchWorkspace("", { onStatus }))[0].name).toBe("available");
    expect(onStatus.calls.mostRecent().args[0]).toEqual({ state: "partial" });
  });
});
