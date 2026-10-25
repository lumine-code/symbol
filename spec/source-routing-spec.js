let SymbolRegistry;

const sourceProvider = (id, score, load = () => [{ name: id, position: [0, 0] }]) => ({
  name: id,
  packageName: id,
  getDocumentSymbolSources: () => [
    { id, name: id, shortLabel: id === "syntax" ? "TS" : "LS", score, state: "ready" },
  ],
  getDocumentSymbols: jasmine.createSpy(`load ${id}`).and.callFake(load),
});

describe("document source routing", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let registry, editor, syntax, semantic, detached, storage;
  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("symbol.providerTimeout", 1000);
    lumine.config.unset("symbol.documentSource", { scopeSelector: ".text.plain" });
    lumine.config.set("symbol.documentSource", "auto");
    lumine.config.set("symbol.preferCertainProviders", []);
    storage = (await lumine.packages.activatePackage("symbol")).mainModule.workspaceState;
    SymbolRegistry = require("../lib/registry");
    await storage.update("documentSources", undefined);
    registry = new SymbolRegistry(storage);
    editor = await lumine.workspace.open();
    syntax = sourceProvider("syntax", 0.999);
    semantic = sourceProvider("semantic", 1);
    registry.addDocumentProviders(syntax, semantic);
  });
  afterEach(() => {
    registry.destroy();
    detached?.destroy();
    detached = null;
    lumine.config.unset("symbol.documentSource", { scopeSelector: ".text.plain" });
    lumine.config.set("symbol.documentSource", "auto");
  });

  it("lists metadata without extraction and identifies a ready empty source", async () => {
    semantic.getDocumentSymbols.and.returnValue([]);
    expect((await registry.listDocumentSources(editor)).map(({ id }) => id)).toEqual([
      "semantic",
      "syntax",
    ]);
    expect(semantic.getDocumentSymbols).not.toHaveBeenCalled();
    expect(syntax.getDocumentSymbols).not.toHaveBeenCalled();
    expect(await registry.getFileSymbols(editor)).toEqual([]);
    const state = registry.getDocumentSourceState(editor);
    expect(state.status).toBe("ready");
    expect(state.mode).toBe("auto");
    expect(state.source.id).toBe("semantic");
    expect(state.source.shortLabel).toBe("LS");
    expect(syntax.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("reuses each unchanged source snapshot and clears all snapshots on text edits", async () => {
    const first = await registry.getFileSymbols(editor);
    await registry.setDocumentSource(editor, "syntax");
    const second = await registry.getFileSymbols(editor);
    await registry.setDocumentSource(editor, "semantic");
    expect(await registry.getFileSymbols(editor)).toBe(first);
    await registry.setDocumentSource(editor, "syntax");
    expect(await registry.getFileSymbols(editor)).toBe(second);
    expect(syntax.getDocumentSymbols).toHaveBeenCalledTimes(1);
    expect(semantic.getDocumentSymbols).toHaveBeenCalledTimes(1);
    spyOn(editor.getBuffer(), "debouncedEmitDidStopChangingEvent");
    editor.setText("changed");
    editor.getBuffer().emitDidStopChangingEvent();
    expect(await registry.getFileSymbols(editor)).not.toBe(second);
    expect(syntax.getDocumentSymbols).toHaveBeenCalledTimes(2);
    await registry.setDocumentSource(editor, "semantic");
    expect(await registry.getFileSymbols(editor)).not.toBe(first);
    expect(semantic.getDocumentSymbols).toHaveBeenCalledTimes(2);
  });

  it("lets a file Auto choice override a manual grammar choice", async () => {
    await registry.setDocumentSource(editor, "syntax", { scope: "grammar" });
    expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
    await registry.setDocumentSource(editor, null);
    expect((await registry.getFileSymbols(editor))[0].name).toBe("semantic");
    expect(registry.getDocumentSourceState(editor).scope).toBe("file");
    expect(
      lumine.config.get("symbol.documentSource", { scope: [editor.getGrammar().scopeName] }),
    ).toBe("syntax");
  });

  it("shares a session choice between views of the same unsaved buffer and restores it", async () => {
    detached = lumine.workspace.buildTextEditor({ buffer: editor.getBuffer() });
    await registry.getFileSymbols(detached);
    await registry.setDocumentSource(editor, "syntax");
    expect((await registry.getFileSymbols(detached))[0].name).toBe("syntax");
    const saved = storage.get("documentSources", []);
    expect(saved).toContain([`buffer:${editor.getBuffer().getId()}`, "syntax"]);
    registry.destroy();
    registry = new SymbolRegistry(storage);
    registry.addDocumentProviders(syntax, semantic);
    expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
    expect(registry.getDocumentSourceState(editor).scope).toBe("file");
  });

  it("keeps a source choice when an unsaved buffer acquires a file URI", async () => {
    await registry.setDocumentSource(editor, "syntax");
    const directory = require("@lumine-code/fs-temp").mkdirSync("symbol-source-save-");
    editor.getBuffer().setPath(require("node:path").join(directory, "saved.txt"));
    expect(registry.getDocumentSourceState(editor).sourceId).toBe("syntax");
    await conditionPromise(() =>
      storage
        .get("documentSources", [])
        .some(([key, source]) => key === `uri:${editor.getURI()}` && source === "syntax"),
    );
    registry.destroy();
    registry = new SymbolRegistry(storage);
    registry.addDocumentProviders(syntax, semantic);
    expect((await registry.getFileSymbols(editor))[0].name).toBe("syntax");
  });

  it("cancels an obsolete source and prevents its late response from replacing the new source", async () => {
    let finish, request;
    semantic.getDocumentSymbols.and.callFake((_editor, options) => {
      request = options;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const old = registry.getFileSymbols(editor);
    await conditionPromise(() => finish);
    await registry.setDocumentSource(editor, "syntax");
    expect(request.signal.aborted).toBe(true);
    expect(await old).toBeNull();
    const current = await registry.getFileSymbols(editor);
    finish([{ name: "obsolete", position: [0, 0] }]);
    await Promise.resolve();
    expect(registry.peekFileSymbols(editor)).toBe(current);
    expect(registry.getDocumentSourceState(editor).source.id).toBe("syntax");
    expect(syntax.getDocumentSymbols.calls.first().args[1].sourceId).toBe("syntax");
  });

  it("retains the full name of a withdrawn manual source without silently falling back", async () => {
    await registry.setDocumentSource(editor, "semantic");
    await registry.getFileSymbols(editor);
    registry.removeDocumentProviders(semantic);
    expect(await registry.getFileSymbols(editor)).toBeNull();
    expect(registry.getDocumentSourceState(editor).status).toBe("unavailable");
    const selected = (await registry.listDocumentSources(editor)).find(
      ({ id }) => id === "semantic",
    );
    expect(selected.name).toBe("semantic");
    expect(selected.state).toBe("unavailable");
    expect(syntax.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("drops obsolete metadata after the buffer invalidates its discovery generation", async () => {
    let finish;
    semantic.getDocumentSymbolSources = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = registry.listDocumentSources(editor);
    await conditionPromise(() => finish);
    editor.setText("changed");
    finish([{ id: "obsolete", name: "Old", shortLabel: "LS", score: 1, state: "ready" }]);
    expect(await pending).toEqual([]);
    expect(registry.sourceDescriptors.get(editor)?.has("obsolete")).not.toBe(true);
  });

  it("shares the request with a consumer that reacts synchronously to loading state", async () => {
    let reentrant;
    registry.onDidChangeDocumentSource(({ editor: changed, state }) => {
      if (changed === editor && state.status === "loading")
        reentrant = registry.getFileSymbols(editor);
    });
    const first = registry.getFileSymbols(editor);
    const symbols = await first;
    expect(await reentrant).toBe(symbols);
    expect(semantic.getDocumentSymbols).toHaveBeenCalledTimes(1);
  });

  it("restores incoming project choices without replacing the registry or its consumers", async () => {
    await registry.setDocumentSource(editor, "syntax");
    const saved = storage.get("documentSources", []);
    const syntaxSnapshot = await registry.getFileSymbols(editor);
    const changed = jasmine.createSpy("invalidated");
    registry.onDidInvalidateFileSymbols(changed);
    await storage.update("documentSources", undefined);
    expect((await registry.getFileSymbols(editor))[0].name).toBe("semantic");
    await storage.update("documentSources", saved);
    expect(await registry.getFileSymbols(editor)).toBe(syntaxSnapshot);
    expect(registry.getDocumentSourceState(editor).scope).toBe("file");
    expect(changed).toHaveBeenCalledTimes(2);
    await storage.update("documentSources", saved);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does not replay an older source choice when rapid local choices are committed", async () => {
    const choices = [];
    registry.onDidInvalidateFileSymbols(({ editor: changed }) => {
      if (changed === editor) choices.push(registry.choiceFor(editor));
    });

    const first = registry.setDocumentSource(editor, "syntax");
    const second = registry.setDocumentSource(editor, "semantic");
    expect(registry.choiceFor(editor)).toBe("semantic");
    await Promise.all([first, second]);

    expect(choices).toEqual(["syntax", "semantic"]);
    expect(registry.choiceFor(editor)).toBe("semantic");
    expect(storage.get("documentSources")).toContain([
      `buffer:${editor.getBuffer().getId()}`,
      "semantic",
    ]);
  });

  it("keeps an incoming project choice when an outgoing choice finishes saving", async () => {
    const paths = lumine.project.getPaths();
    const key = `buffer:${editor.getBuffer().getId()}`;
    lumine.project.setPaths([__dirname]);
    await storage.update("documentSources", [[key, "semantic"]]);
    lumine.project.setPaths(paths);
    const mutate = storage.mutate.bind(storage);
    let release;
    let didCommit;
    const committed = new Promise((resolve) => (didCommit = resolve));
    spyOn(storage, "mutate").and.callFake((...args) =>
      mutate(...args).then(
        (value) =>
          new Promise((resolve) => {
            release = () => resolve(value);
            didCommit();
          }),
      ),
    );
    const saving = registry.setDocumentSource(editor, "syntax");
    await committed;
    try {
      lumine.project.setPaths([__dirname]);
      expect(registry.choiceFor(editor)).toBe("semantic");
      release();
      await saving;
      expect(registry.choiceFor(editor)).toBe("semantic");
      expect(storage.get("documentSources")).toEqual([[key, "semantic"]]);
    } finally {
      release();
      await saving;
      lumine.project.setPaths(paths);
    }
  });

  it("restores the committed source after a local source choice fails to save", async () => {
    await registry.setDocumentSource(editor, "semantic");
    spyOn(lumine.notifications, "addError");
    spyOn(storage, "mutate").and.rejectWith(new Error("storage unavailable"));

    await expectAsync(registry.setDocumentSource(editor, "syntax")).toBeRejectedWithError(
      "storage unavailable",
    );

    expect(registry.choiceFor(editor)).toBe("semantic");
    expect(lumine.notifications.addError).toHaveBeenCalled();
  });

  it("lets a local fallback finish after the remote response deadline", async () => {
    lumine.config.set("symbol.providerTimeout", 5);
    syntax.getDocumentSymbolSources = () => [
      {
        id: "syntax",
        name: "syntax",
        shortLabel: "TS",
        score: 0.999,
        state: "ready",
        execution: "local",
      },
    ];
    semantic.getDocumentSymbols.and.callFake(() => new Promise(() => {}));
    syntax.getDocumentSymbols.and.callFake((_editor, request) => {
      expect(request.timeoutMs).toBe(0);
      return new Promise((resolve) =>
        setTimeout(() => resolve([{ name: "local", position: [0, 0] }]), 25),
      );
    });
    const found = await registry.getFileSymbols(editor);
    expect(found.map(({ name }) => name)).toEqual(["local"]);
    expect(semantic.getDocumentSymbols.calls.first().args[1].signal.aborted).toBe(true);
    expect(syntax.getDocumentSymbols.calls.first().args[1].signal.aborted).toBe(false);
    expect(registry.getDocumentSourceState(editor).source.id).toBe("syntax");
    expect(registry.getDocumentSourceState(editor).status).toBe("ready");
  });

  it("withdraws a local fallback when the buffer changes while extraction is pending", async () => {
    lumine.config.set("symbol.providerTimeout", 5);
    syntax.getDocumentSymbolSources = () => [
      {
        id: "syntax",
        name: "syntax",
        shortLabel: "TS",
        score: 0.999,
        state: "ready",
        execution: "local",
      },
    ];
    semantic.getDocumentSymbols.and.returnValue(null);
    let finish, localRequest;
    syntax.getDocumentSymbols.and.callFake((_editor, request) => {
      localRequest = request;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = registry.getFileSymbols(editor);
    await conditionPromise(() => finish);
    spyOn(editor.getBuffer(), "debouncedEmitDidStopChangingEvent");
    editor.setText("updated");
    expect(localRequest.signal.aborted).toBe(true);
    expect(await pending).toBeNull();
    finish([{ name: "obsolete", position: [0, 0] }]);
    await Promise.resolve();
    expect(registry.peekFileSymbols(editor)).toBeNull();
    expect(registry.getDocumentSourceState(editor).status).toBe("idle");
  });
});
