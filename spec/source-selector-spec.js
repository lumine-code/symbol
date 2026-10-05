const { Emitter } = require("lumine");
let SourceStatusView, SourceListView;

const treeSitter = {
  id: "symbol-tree-sitter",
  name: "Tree-sitter",
  shortLabel: "TS",
  packageName: "symbol-tree-sitter",
  score: 0.999,
  state: "ready",
};
const languageServer = {
  id: "ide-sofistik",
  name: "SOFiSTiK Language Server",
  shortLabel: "LS",
  packageName: "ide-client",
  score: 1,
  state: "ready",
};

function registryStub() {
  const emitter = new Emitter();
  const states = new Map();
  return {
    emitter,
    sources: [treeSitter, languageServer],
    getDocumentSourceState(editor) {
      return (
        states.get(editor) || { mode: "auto", sourceId: null, source: treeSitter, status: "ready" }
      );
    },
    setState(editor, state) {
      states.set(editor, state);
      emitter.emit("source", { editor, state });
    },
    setDocumentSource(editor, id, options) {
      this.setState(editor, {
        mode: id == null ? "auto" : "manual",
        scope: options?.scope || "file",
        sourceId: id,
        source: this.sources.find((source) => source.id === id) || treeSitter,
        status: "ready",
      });
    },
    listDocumentSources() {
      return Promise.resolve(this.sources);
    },
    getFileSymbols() {
      return Promise.resolve([]);
    },
    onDidChangeDocumentSource(callback) {
      return emitter.on("source", callback);
    },
    onDidInvalidateFileSymbols(callback) {
      return emitter.on("invalidate", callback);
    },
    onDidChangeProviders(callback) {
      return emitter.on("providers", callback);
    },
  };
}

async function render() {
  await new Promise((resolve) => lumine.views.updateDocument(resolve));
}

function enterIn(list, { alt = false } = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    altKey: alt,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "target", { value: list.getQueryEditor().getElement() });
  lumine.keymaps.handleKeyboardEvent(event);
}

describe("document symbol source selector", () => {
  let editor, registry, statusView, listView, statusBar;

  beforeEach(async () => {
    SourceStatusView = require("../lib/source-status-view");
    SourceListView = require("../lib/source-list-view");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.config.set("symbol.showStatusBarItem", true);
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", true);
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("grammar-selector");
    statusBar = lumine.packages.getActivePackage("status-bar").mainModule.provideStatusBar();
    editor = await lumine.workspace.open();
    registry = registryStub();
    spyOn(registry, "getFileSymbols").and.callThrough();
    spyOn(registry, "setDocumentSource").and.callThrough();
  });

  afterEach(async () => {
    statusView?.destroy();
    await listView?.destroy();
    registry.emitter.dispose();
    statusView = null;
    listView = null;
  });

  it("places the source directly after the grammar tile on either side", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    await render();
    const grammar = document.querySelector(".grammar-status");
    expect(grammar.nextElementSibling).toBe(statusView.element);
    expect(statusView.tile.getPriority()).toBe(405);
    expect(statusBar.getRightTiles().map((tile) => tile.getItem())).toContain(statusView.element);

    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    expect(grammar.nextElementSibling).toBe(statusView.element);
    expect(statusView.tile.getPriority()).toBe(330);
    expect(statusBar.getLeftTiles().map((tile) => tile.getItem())).toContain(statusView.element);
    expect(statusBar.getRightTiles().map((tile) => tile.getItem())).not.toContain(
      statusView.element,
    );
  });

  it("keeps the effective source visible for a successful empty symbol result", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    await render();
    expect(registry.getFileSymbols).toHaveBeenCalledWith(editor);
    expect(await registry.getFileSymbols(editor)).toEqual([]);
    expect(statusView.button.textContent).toBe("TS");
    expect(statusView.tooltipContent.textContent).toBe("This file uses Tree-sitter symbols.");
    expect(registry.getDocumentSourceState(editor).mode).toBe("auto");
  });

  it("toggles the tile setting without requesting any symbols", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    await render();
    registry.getFileSymbols.calls.reset();
    lumine.config.set("symbol.showStatusBarItem", false);
    expect(statusView.tile).toBeNull();
    expect(statusView.element.isConnected).toBe(false);
    lumine.config.set("symbol.showStatusBarItem", true);
    await render();
    expect(statusView.element.isConnected).toBe(true);
    expect(statusView.button.textContent).toBe("TS");
    expect(registry.getFileSymbols).not.toHaveBeenCalled();
  });

  it("updates the short label and full tooltip after a source selection changes", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    registry.setDocumentSource(editor, languageServer.id);
    await render();
    expect(statusView.button.textContent).toBe("LS");
    expect(statusView.tooltipContent.textContent).toBe(
      "This file uses SOFiSTiK Language Server symbols.",
    );
    expect(registry.getDocumentSourceState(editor).mode).toBe("manual");
    expect(registry.getDocumentSourceState(editor).scope).toBe("file");
    expect(statusView.button.getAttribute("aria-label")).toBe(
      statusView.tooltipContent.textContent,
    );
    expect(statusView.button.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("distinguishes pending, unavailable and failed source states", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    for (const [status, label, text] of [
      ["loading", "LS", "This file uses SOFiSTiK Language Server symbols."],
      ["starting", "LS", "This file uses SOFiSTiK Language Server symbols."],
      ["unavailable", "—", "unavailable"],
      ["error", "—", "Could not load"],
    ]) {
      registry.setState(editor, {
        mode: "manual",
        sourceId: languageServer.id,
        source: languageServer,
        status,
        message: "Details",
      });
      await render();
      expect(statusView.button.textContent).toBe(label);
      expect(statusView.tooltipContent.textContent).toContain(text);
      if (["unavailable", "error"].includes(status)) {
        expect(statusView.tooltipContent.textContent).toContain("Details");
      } else {
        expect(statusView.tooltipContent.textContent).toBe(text);
      }
    }
  });

  it("retains the previous label until a synchronous source candidate is known", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    await render();
    expect(statusView.button.textContent).toBe("TS");
    for (const [status, source, label, name] of [
      ["idle", null, "TS", "Tree-sitter"],
      ["loading", languageServer, "LS", "SOFiSTiK Language Server"],
      ["starting", treeSitter, "TS", "Tree-sitter"],
    ]) {
      registry.setState(editor, { mode: "auto", sourceId: null, source, status });
      await render();
      expect(statusView.button.textContent).toBe(label);
      expect(statusView.element.style.display).toBe("");
      expect(statusView.tooltipContent.textContent).toBe(`This file uses ${name} symbols.`);
    }
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    await render();
    expect(statusView.button.textContent).toBe("LS");
    expect(statusView.tooltipContent.textContent).toBe(
      "This file uses SOFiSTiK Language Server symbols.",
    );
  });

  it("hides an unknown cold source and shows a metadata source before extraction finishes", async () => {
    registry.setState(editor, { mode: "auto", sourceId: null, source: null, status: "loading" });
    statusView = new SourceStatusView(statusBar, registry, () => {});
    await render();
    expect(statusView.element.style.display).toBe("none");
    expect(statusView.button.textContent).toBe("");
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: treeSitter,
      status: "loading",
    });
    await render();
    expect(statusView.element.style.display).toBe("");
    expect(statusView.button.textContent).toBe("TS");
    expect(statusView.tooltipContent.textContent).toBe("This file uses Tree-sitter symbols.");
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    await render();
    expect(statusView.button.textContent).toBe("LS");
    expect(statusView.tooltipContent.textContent).toBe(
      "This file uses SOFiSTiK Language Server symbols.",
    );
  });

  it("describes the active notebook cell and hides without a text editor", async () => {
    statusView = new SourceStatusView(statusBar, registry, () => {});
    const embedded = lumine.workspace.buildTextEditor({ autoHeight: true });
    registry.setState(embedded, {
      mode: "manual",
      sourceId: languageServer.id,
      source: languageServer,
      status: "ready",
    });
    const item = document.createElement("div");
    item.getTitle = () => "Notebook";
    item.getActiveEmbeddedTextEditor = () => embedded;
    item.onDidChangeActiveTextEditors = () => ({ dispose() {} });
    const pane = lumine.workspace.getCenter().getActivePane();
    try {
      pane.activateItem(item);
      await render();
      expect(lumine.workspace.getActiveTextEditor()).toBeUndefined();
      expect(statusView.editor).toBe(embedded);
      expect(statusView.button.textContent).toBe("LS");
      expect(registry.getFileSymbols).toHaveBeenCalledWith(embedded);
      const noEditor = document.createElement("div");
      noEditor.getTitle = () => "Preview";
      pane.activateItem(noEditor);
      await render();
      expect(statusView.element.style.display).toBe("none");
    } finally {
      pane.activateItem(editor);
      embedded.destroy();
    }
  });

  it("ignores completion of a previous editor request", async () => {
    let finish;
    registry.getFileSymbols.and.callFake((target) =>
      target === editor ? new Promise((resolve) => (finish = resolve)) : Promise.resolve([]),
    );
    statusView = new SourceStatusView(statusBar, registry, () => {});
    const other = await lumine.workspace.open();
    registry.setState(other, {
      mode: "manual",
      sourceId: languageServer.id,
      source: languageServer,
      status: "ready",
    });
    await render();
    finish([]);
    await render();
    expect(statusView.editor).toBe(other);
    expect(statusView.button.textContent).toBe("LS");
  });

  it("opens the selector for the editor the tile describes and disposes its hooks", async () => {
    const show = jasmine.createSpy("show");
    statusView = new SourceStatusView(statusBar, registry, show);
    await render();
    statusView.button.click();
    expect(show).toHaveBeenCalledWith(editor);
    registry.getFileSymbols.calls.reset();
    const element = statusView.element;
    statusView.destroy();
    registry.emitter.emit("invalidate", { editor });
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    await render();
    expect(element.isConnected).toBe(false);
    expect(registry.getFileSymbols).not.toHaveBeenCalled();
  });

  it("opens once from the whole tile or its keyboard button and preserves editor focus", async () => {
    const show = jasmine.createSpy("show");
    statusView = new SourceStatusView(statusBar, registry, show);
    await render();
    statusView.element.click();
    expect(show).toHaveBeenCalledOnceWith(editor);
    statusView.button.click();
    expect(show).toHaveBeenCalledTimes(2);
    statusView.button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, detail: 0 }),
    );
    expect(show).toHaveBeenCalledTimes(3);
    expect(show.calls.allArgs()).toEqual([[editor], [editor], [editor]]);
    statusView.element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 2 }));
    expect(show).toHaveBeenCalledTimes(3);

    editor.getElement().focus();
    const mouseDown = new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true });
    statusView.element.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    expect(editor.getElement().contains(document.activeElement)).toBe(true);
    statusView.destroy();
    statusView.element.click();
    statusView.button.click();
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("checks Auto and marks its effective source separately with one keyboard selection", async () => {
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    const items = listView.selectList.getDisplayedItems();
    expect(items.map((source) => source.name)).toEqual([
      "Auto detect",
      "Tree-sitter",
      "SOFiSTiK Language Server",
    ]);
    const element = listView.selectList.getElement();
    expect(
      Array.from(element.querySelectorAll("li.active"), (row) => row.dataset.sourceId),
    ).toEqual(["symbol:auto"]);
    expect(
      Array.from(element.querySelectorAll("li.auto-selected"), (row) => row.dataset.sourceId),
    ).toEqual([treeSitter.id]);
    expect(
      Array.from(element.querySelectorAll("li.selected"), (row) => row.dataset.sourceId),
    ).toEqual(["symbol:auto"]);
    expect(element.querySelector(".select-list-separator")).toBeNull();
    expect(Array.from(element.querySelectorAll(".badge"), (badge) => badge.textContent)).toEqual([
      "TS",
      "LS",
    ]);
    expect(registry.getFileSymbols).not.toHaveBeenCalled();
    expect(element.querySelector('[data-source-id="symbol:auto"] .secondary-line')).toBeNull();
    expect(element.querySelector(".select-list-info, .info-message")).toBeNull();
    expect(listView.selectList.getInfoMessage()).toBeNull();
    expect(element.textContent).not.toContain("ide-client");
  });

  it("keeps a short source list in provider order while marking the effective Auto source", async () => {
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    expect(listView.selectList.getDisplayedItems().map((source) => source.id)).toEqual([
      "symbol:auto",
      treeSitter.id,
      languageServer.id,
    ]);
    const element = listView.selectList.getElement();
    expect(
      Array.from(element.querySelectorAll("li.active"), (row) => row.dataset.sourceId),
    ).toEqual(["symbol:auto"]);
    expect(
      Array.from(element.querySelectorAll("li.auto-selected"), (row) => row.dataset.sourceId),
    ).toEqual([languageServer.id]);
    expect(element.querySelector("li.selected").dataset.sourceId).toBe("symbol:auto");
    expect(element.querySelector(".select-list-separator")).toBeNull();
    expect(registry.getFileSymbols).not.toHaveBeenCalled();
  });

  it("hoists the effective Auto source only when the source list scrolls", async () => {
    const alternatives = Array.from({ length: 10 }, (_, index) => ({
      ...languageServer,
      id: `source-${index}`,
      name: `Additional Source ${index}`,
    }));
    registry.sources = [treeSitter, ...alternatives, languageServer];
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    const element = listView.selectList.getElement();
    const scroller = element.querySelector("ol.list-group");
    scroller.style.maxHeight = "80px";
    scroller.style.overflowY = "auto";
    await conditionPromise(async () => {
      await render();
      return listView.selectList.getDisplayedItems()[1]?.id === languageServer.id;
    }, "effective source pinned in an overflowing list");
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(
      element.querySelector(`[data-source-id="${languageServer.id}"]`).nextElementSibling,
    ).toBe(element.querySelector(".select-list-separator"));
    expect(element.querySelector("li.auto-selected").dataset.sourceId).toBe(languageServer.id);
    expect(element.querySelector("li.selected").dataset.sourceId).toBe("symbol:auto");

    scroller.style.maxHeight = "1000px";
    await conditionPromise(async () => {
      await render();
      return listView.selectList.getDisplayedItems()[1]?.id === treeSitter.id;
    }, "natural source order after the list stops scrolling");
    expect(element.querySelector(".select-list-separator")).toBeNull();
    expect(listView.selectList.getDisplayedItems().map((source) => source.id)).toEqual([
      "symbol:auto",
      ...registry.sources.map((source) => source.id),
    ]);
  });

  for (const status of ["idle", "loading", "starting", "unavailable", "error"]) {
    it(`does not mark a candidate as an effective Auto source while ${status}`, async () => {
      registry.setState(editor, {
        mode: "auto",
        sourceId: null,
        source: languageServer,
        status,
      });
      listView = new SourceListView(registry);
      await listView.toggle(editor);
      const element = listView.selectList.getElement();
      expect(
        Array.from(element.querySelectorAll("li.active"), (row) => row.dataset.sourceId),
      ).toEqual(["symbol:auto"]);
      expect(element.querySelector("li.auto-selected")).toBeNull();
      expect(listView.selectList.getDisplayedItems().map((source) => source.id)).toEqual([
        "symbol:auto",
        treeSitter.id,
        languageServer.id,
      ]);
    });
  }

  it("updates the effective Auto source without moving the keyboard selection", async () => {
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    await listView.selectList.selectItemById(languageServer.id);
    registry.setState(editor, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    await render();
    const element = listView.selectList.getElement();
    expect(
      Array.from(element.querySelectorAll("li.active"), (row) => row.dataset.sourceId),
    ).toEqual(["symbol:auto"]);
    expect(
      Array.from(element.querySelectorAll("li.auto-selected"), (row) => row.dataset.sourceId),
    ).toEqual([languageServer.id]);
    expect(
      Array.from(element.querySelectorAll("li.selected"), (row) => row.dataset.sourceId),
    ).toEqual([languageServer.id]);
  });

  it("selects the manual source when an opening refresh is superseded", async () => {
    registry.setDocumentSource(editor, languageServer.id);
    const pending = [];
    spyOn(registry, "listDocumentSources").and.callFake(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    listView = new SourceListView(registry);
    const opening = listView.toggle(editor);
    await conditionPromise(() => pending.length === 1, "opening source list request");
    registry.emitter.emit("providers");
    await conditionPromise(() => pending.length === 2, "replacement source list request");
    for (const resolve of pending) resolve(registry.sources);
    await opening;
    await render();
    expect(listView.selectList.getElement().querySelector("li.selected").dataset.sourceId).toBe(
      languageServer.id,
    );
  });

  it("applies selection to the opening editor and returns its focus", async () => {
    listView = new SourceListView(registry);
    editor.getElement().focus();
    await listView.toggle(editor);
    expect(listView.selectList.getQueryEditor().getElement().contains(document.activeElement)).toBe(
      true,
    );
    await listView.selectList.selectItemById(languageServer.id);
    await listView.selectList.confirmSelection();
    expect(registry.setDocumentSource).toHaveBeenCalledWith(editor, languageServer.id);
    expect(listView.selectListHost.isVisible()).toBe(false);
    expect(editor.getElement().contains(document.activeElement)).toBe(true);
  });

  it("marks the manual choice and lets Auto remove it", async () => {
    registry.setDocumentSource(editor, languageServer.id);
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    const element = listView.selectList.getElement();
    expect(
      Array.from(element.querySelectorAll("li.active"), (row) => row.dataset.sourceId),
    ).toEqual([languageServer.id]);
    expect(element.querySelector("li.auto-selected")).toBeNull();
    expect(element.querySelector("li.selected").dataset.sourceId).toBe(languageServer.id);
    expect(listView.selectList.getDisplayedItems().map((source) => source.id)).toEqual([
      "symbol:auto",
      treeSitter.id,
      languageServer.id,
    ]);
    expect(element.querySelector(".select-list-separator")).toBeNull();
    await listView.selectList.selectItemById("symbol:auto");
    await listView.selectList.confirmSelection();
    expect(registry.setDocumentSource).toHaveBeenCalledWith(editor, null);
  });

  it("dispatches Enter for this file and Alt-Enter for the grammar", async () => {
    // The package's scoped keymap belongs to the real package generation.
    await lumine.packages.activatePackage("symbol");
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    await listView.selectList.selectItemById(languageServer.id);
    enterIn(listView.selectList);
    await render();
    expect(registry.setDocumentSource).toHaveBeenCalledWith(editor, languageServer.id);
    await listView.toggle(editor);
    await listView.selectList.selectItemById(treeSitter.id);
    enterIn(listView.selectList, { alt: true });
    await render();
    expect(registry.setDocumentSource).toHaveBeenCalledWith(editor, treeSitter.id, {
      scope: "grammar",
    });
  });

  it("keeps an inherited Grammar choice in state without an information banner", async () => {
    registry.setState(editor, {
      mode: "manual",
      scope: "grammar",
      sourceId: languageServer.id,
      source: languageServer,
      status: "ready",
    });
    statusView = new SourceStatusView(statusBar, registry, () => {});
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    await render();
    expect(statusView.tooltipContent.textContent).toBe(
      "This file uses SOFiSTiK Language Server symbols.",
    );
    expect(registry.getDocumentSourceState(editor).scope).toBe("grammar");
    expect(
      listView.selectList.getElement().querySelector(".select-list-info, .info-message"),
    ).toBeNull();
    expect(listView.selectList.getInfoMessage()).toBeNull();
  });

  it("keeps an unavailable manual source checked and disabled until Auto is chosen", async () => {
    registry.sources = [treeSitter];
    registry.setState(editor, {
      mode: "manual",
      sourceId: languageServer.id,
      source: languageServer,
      status: "unavailable",
    });
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    const element = listView.selectList.getElement();
    const row = element.querySelector(`[data-source-id="${languageServer.id}"]`);
    expect(row.classList.contains("active")).toBe(true);
    expect(row.classList.contains("unavailable")).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.querySelector(".secondary-line").textContent).toBe(
      "This source is unavailable for this document.",
    );
    expect(element.querySelector("li.selected").dataset.sourceId).toBe(languageServer.id);
    expect(element.querySelector(".select-list-info, .info-message")).toBeNull();
    expect(listView.selectList.getInfoMessage()).toBeNull();
    expect(registry.getDocumentSourceState(editor).sourceId).toBe(languageServer.id);
    expect(registry.getDocumentSourceState(editor).mode).toBe("manual");
    await listView.selectList.confirmSelection();
    expect(registry.setDocumentSource).not.toHaveBeenCalled();
    expect(listView.selectListHost.isVisible()).toBe(true);
    await listView.selectList.selectItemById("symbol:auto");
    await listView.selectList.confirmSelection();
    expect(registry.setDocumentSource).toHaveBeenCalledWith(editor, null);
  });

  it("always lists Tree-sitter while excluding language servers without symbol capability", async () => {
    registry.sources = [treeSitter, { ...languageServer, score: 0, state: "unavailable" }];
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    expect(listView.selectList.getDisplayedItems().map((source) => source.id)).toEqual([
      "symbol:auto",
      "symbol-tree-sitter",
    ]);
    const row = listView.selectList
      .getElement()
      .querySelector(`[data-source-id="${treeSitter.id}"]`);
    expect(row.getAttribute("aria-disabled")).toBe("false");
  });

  it("refreshes source availability while the selector is open", async () => {
    listView = new SourceListView(registry);
    await listView.toggle(editor);
    registry.sources = [
      treeSitter,
      { ...languageServer, score: 0, state: "starting", message: "Starting SOFiSTiK" },
    ];
    registry.emitter.emit("providers");
    await render();
    const row = listView.selectList
      .getElement()
      .querySelector(`[data-source-id="${languageServer.id}"]`);
    expect(row).toBeNull();
    expect(registry.getFileSymbols).not.toHaveBeenCalled();
  });

  it("drops late source lists after cancellation and a new editor opening", async () => {
    let finish;
    spyOn(registry, "listDocumentSources").and.callFake((target) =>
      target === editor
        ? new Promise((resolve) => (finish = resolve))
        : Promise.resolve([languageServer]),
    );
    listView = new SourceListView(registry);
    const first = listView.toggle(editor);
    await render();
    listView.selectListHost.cancel();
    const other = await lumine.workspace.open();
    registry.setState(other, {
      mode: "auto",
      sourceId: null,
      source: languageServer,
      status: "ready",
    });
    await listView.toggle(other);
    finish([treeSitter]);
    await first;
    expect(listView.editor).toBe(other);
    expect(listView.selectList.getDisplayedItems().map((source) => source.name)).toEqual([
      "Auto detect",
      "SOFiSTiK Language Server",
    ]);
  });

  it("does not reopen a destroyed selector when metadata arrives late", async () => {
    let finish;
    spyOn(registry, "listDocumentSources").and.returnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    listView = new SourceListView(registry);
    const opening = listView.toggle(editor);
    await render();
    await listView.destroy();
    finish([treeSitter]);
    await opening;
    expect(listView.selectListHost.isVisible()).toBe(false);
    expect(listView.editor).toBeNull();
  });
});

describe("document symbol source selector integration", () => {
  let editor,
    main,
    service,
    providerEdge,
    invalidationSubscription,
    invalidations,
    languageProvider;
  const sourceId = "ui-test:language-server";

  async function readySource(id) {
    await conditionPromise(async () => {
      await render();
      const state = service.getDocumentSourceState(editor);
      return state.status === "ready" && state.source?.id === id;
    }, `effective document source ${id}`);
  }

  async function openListFromTile() {
    const tile = document.querySelector(".symbol-source-status .symbol-source-button");
    tile.click();
    await conditionPromise(async () => {
      await render();
      return (
        main.sourceListView?.selectListHost.isVisible() &&
        main.sourceListView.selectList.getDisplayedItems().some((source) => source.id === sourceId)
      );
    }, "document source selector from its status tile");
    return main.sourceListView.selectList;
  }

  beforeEach(async () => {
    jasmine.unspy(Date, "now");
    jasmine.unspy(global, "setTimeout");
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", true);
    lumine.config.set("symbol.showStatusBarItem", true);
    await lumine.packages.activatePackage("status-bar");
    await lumine.packages.activatePackage("grammar-selector");
    await lumine.packages.activatePackage("language-javascript");
    editor = await lumine.workspace.open();
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.js"));
    editor.setText("function SourceSelectorIntegration() {}\n");
    await editor.whenGrammarSettled();
    await lumine.packages.activatePackage("symbol");
    main = lumine.packages.getActivePackage("symbol").mainModule;
    service = main.provideSymbolRegistry();
    await lumine.packages.activatePackage("symbol-tree-sitter");
    const treeProvider = lumine.packages
      .getActivePackage("symbol-tree-sitter")
      .mainModule.provideDocumentSymbolProvider();
    expect(typeof treeProvider.getDocumentSymbolSources).toBe("function");
    expect(treeProvider.canProvideDocumentSymbols).toBeUndefined();
    languageProvider = {
      name: "UI Test Language Server",
      packageName: "ui-test-language-server",
      getDocumentSymbolSources(target, { signal }) {
        signal.throwIfAborted();
        return target.getGrammar().scopeName === "source.js"
          ? [
              {
                id: sourceId,
                name: "UI Test Language Server",
                shortLabel: "LS",
                score: 1,
                state: "ready",
              },
            ]
          : [];
      },
      getDocumentSymbols(_target, { sourceId: selected, signal }) {
        signal.throwIfAborted();
        if (selected !== sourceId) throw new Error("Incorrect document source ID");
        return [];
      },
    };
    spyOn(languageProvider, "getDocumentSymbols").and.callThrough();
    providerEdge = main.consumeDocumentSymbolProvider(languageProvider);
    invalidations = [];
    invalidationSubscription = service.onDidInvalidateFileSymbols((event) =>
      invalidations.push(event),
    );
    await readySource(sourceId);
  });

  afterEach(() => {
    invalidationSubscription.dispose();
    providerEdge.dispose();
  });

  it("switches actual sources from the tile and exposes ready empty answers", async () => {
    expect(await service.getFileSymbols(editor)).toEqual([]);
    const tile = document.querySelector(".symbol-source-status .symbol-source-button");
    expect(tile.textContent).toBe("LS");
    expect(tile.getAttribute("aria-label")).toBe("This file uses UI Test Language Server symbols.");
    expect(service.getDocumentSourceState(editor).mode).toBe("auto");
    let list = await openListFromTile();
    await list.selectItemById("symbol-tree-sitter");
    enterIn(list);
    await readySource("symbol-tree-sitter");
    expect(tile.textContent).toBe("TS");
    expect(service.getDocumentSourceState(editor).scope).toBe("file");
    expect((await service.getFileSymbols(editor)).map((symbol) => symbol.name)).toContain(
      "SourceSelectorIntegration",
    );
    expect(invalidations.some((event) => event.editor === editor)).toBe(true);

    list = await openListFromTile();
    await list.selectItemById(sourceId);
    enterIn(list);
    await readySource(sourceId);
    expect(tile.textContent).toBe("LS");
    expect(await service.getFileSymbols(editor)).toEqual([]);
    expect(tile.getAttribute("aria-label")).toBe("This file uses UI Test Language Server symbols.");
    expect(service.getDocumentSourceState(editor).mode).toBe("manual");
    expect(service.getDocumentSourceState(editor).scope).toBe("file");

    list = await openListFromTile();
    await list.selectItemById("symbol:auto");
    enterIn(list);
    await readySource(sourceId);
    expect(service.getDocumentSourceState(editor).mode).toBe("auto");
    expect(tile.textContent).toBe("LS");
    expect(tile.getAttribute("aria-label")).toBe("This file uses UI Test Language Server symbols.");
    expect(service.getDocumentSourceState(editor).scope).toBe("file");
  });

  it("keeps the workspace command available when the tile setting is disabled", async () => {
    lumine.config.set("symbol.showStatusBarItem", false);
    expect(document.querySelector(".symbol-source-status")).toBeNull();
    lumine.commands.dispatch(
      lumine.views.getView(lumine.workspace),
      "symbol:select-document-source",
    );
    await conditionPromise(async () => {
      await render();
      return (
        main.sourceListView?.selectListHost.isVisible() &&
        main.sourceListView.selectList.getDisplayedItems().some((source) => source.id === sourceId)
      );
    }, "document source command without a visible status tile");
    expect(main.sourceListView.editor).toBe(editor);
    await main.sourceListView.selectList.selectItemById("symbol-tree-sitter");
    enterIn(main.sourceListView.selectList, { alt: true });
    await conditionPromise(
      () => service.getDocumentSourceState(editor).sourceId === "symbol-tree-sitter",
      "grammar choice from the alternate picker action",
    );
    await service.getFileSymbols(editor);
    expect(service.getDocumentSourceState(editor).scope).toBe("grammar");
    expect(service.getDocumentSourceState(editor).sourceId).toBe("symbol-tree-sitter");
  });

  it("restores a file choice from the public environment's serialized package state", async () => {
    const list = await openListFromTile();
    await list.selectItemById("symbol-tree-sitter");
    enterIn(list);
    await readySource("symbol-tree-sitter");
    const previousMain = main;
    const previousService = service;
    const previousTile = document.querySelector(".symbol-source-status");
    const state = JSON.parse(JSON.stringify(lumine.serialize())).packageStates.symbol;
    expect(state.documentSources.some((entry) => entry[1] === "symbol-tree-sitter")).toBe(true);
    expect(lumine.config.get("symbol.documentSource", { scope: ["source.js"] })).toBe("auto");

    // Reconstruct the package generation from the same package-state payload
    // the environment restores when reopening its project state.
    invalidationSubscription.dispose();
    providerEdge.dispose();
    await lumine.packages.unloadPackage("symbol", { serialize: false });
    lumine.packages.setPackageState("symbol", state);
    await lumine.packages.activatePackage("symbol");
    main = lumine.packages.getActivePackage("symbol").mainModule;
    service = main.provideSymbolRegistry();
    expect(main).not.toBe(previousMain);
    expect(service).not.toBe(previousService);
    await readySource("symbol-tree-sitter");
    expect(service.getDocumentSourceState(editor).scope).toBe("file");
    expect(service.getDocumentSourceState(editor).sourceId).toBe("symbol-tree-sitter");
    const tile = document.querySelector(".symbol-source-status");
    expect(tile).not.toBe(previousTile);
    expect(previousTile.isConnected).toBe(false);
    expect(tile.textContent).toBe("TS");
    expect(tile.querySelector("button").getAttribute("aria-label")).toBe(
      "This file uses Tree-sitter symbols.",
    );
    const flat = await service.getFileSymbols(editor);
    const tree = await service.getFileSymbolTree(editor);
    expect(flat.some((symbol) => symbol.name === "SourceSelectorIntegration")).toBe(true);
    expect(tree.some((symbol) => symbol.name === "SourceSelectorIntegration")).toBe(true);
  });

  it("shares extraction with a consumer that requests symbols from a source-state event", async () => {
    const reentrant = [];
    const subscription = service.onDidChangeDocumentSource(({ editor: target, state }) => {
      if (target === editor && state.status === "loading")
        reentrant.push(service.getFileSymbols(editor));
    });
    try {
      languageProvider.getDocumentSymbols.calls.reset();
      editor.setText("function UpdatedSourceSelector() {}\n");
      const result = await service.getFileSymbols(editor);
      const observed = await Promise.all(reentrant);
      expect(languageProvider.getDocumentSymbols).toHaveBeenCalledTimes(1);
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((symbols) => symbols === result)).toBe(true);
    } finally {
      subscription.dispose();
    }
  });

  it("restores project source choices through public deserialization without reactivating the package", async () => {
    const list = await openListFromTile();
    await list.selectItemById("symbol-tree-sitter");
    enterIn(list);
    await readySource("symbol-tree-sitter");
    const snapshot = JSON.parse(JSON.stringify(lumine.serialize()));
    const saved = snapshot.packageStates.symbol;
    const restore = (symbolState) =>
      lumine.deserialize(
        {
          packageStates: { symbol: symbolState },
          uriHistory: snapshot.uriHistory,
          fullScreen: snapshot.fullScreen,
        },
        { preservePackageState: true },
      );

    await restore({ documentSources: [] });
    await readySource(sourceId);
    expect(lumine.packages.getActivePackage("symbol").mainModule).toBe(main);
    expect(main.provideSymbolRegistry()).toBe(service);
    expect(service.getDocumentSourceState(editor).mode).toBe("auto");
    expect(service.getDocumentSourceState(editor).scope).toBe("grammar");
    expect(document.querySelector(".symbol-source-status").textContent).toBe("LS");

    await restore(saved);
    await readySource("symbol-tree-sitter");
    expect(lumine.packages.getActivePackage("symbol").mainModule).toBe(main);
    expect(main.provideSymbolRegistry()).toBe(service);
    expect(service.getDocumentSourceState(editor).mode).toBe("manual");
    expect(service.getDocumentSourceState(editor).scope).toBe("file");
    expect(service.getDocumentSourceState(editor).sourceId).toBe("symbol-tree-sitter");
    expect(document.querySelector(".symbol-source-status").textContent).toBe("TS");
    expect(lumine.workspace.getActiveTextEditor()).toBe(editor);
  });

  for (const failure of ["reject", "timeout"]) {
    it(`keeps slow local Tree-sitter symbols pending after a remote source ${failure}`, async () => {
      const remoteBudget = 25;
      lumine.config.set("symbol.providerTimeout", remoteBudget);
      await service.getFileSymbols(editor);
      const stopped = new Promise((resolve) => {
        const subscription = editor.getBuffer().onDidStopChanging(() => {
          subscription.dispose();
          resolve();
        });
      });
      editor.setText("function SlowFallbackSymbols() {}\n");
      await stopped;
      await service.getFileSymbols(editor);

      const sources = await service.listDocumentSources(editor);
      expect(sources.find((source) => source.id === "symbol-tree-sitter").execution).toBe("local");
      const getCaptures = editor.getGrammarQueryCaptureGroups.bind(editor);
      let release, started;
      const captureStarted = new Promise((resolve) => (started = resolve));
      const captureHold = new Promise((resolve) => (release = resolve));
      spyOn(editor, "getGrammarQueryCaptureGroups").and.callFake(async (query, options) => {
        started(options);
        await captureHold;
        return getCaptures(query, options);
      });
      spyOn(console, "error");
      languageProvider.getDocumentSymbols.calls.reset();
      languageProvider.getDocumentSymbols.and.callFake(() =>
        failure === "reject"
          ? Promise.reject(new Error("Remote language server failed"))
          : new Promise(() => {}),
      );

      // Re-register the public service edge to invalidate the preceding
      // successful empty answer without reaching into the registry cache.
      providerEdge.dispose();
      providerEdge = main.consumeDocumentSymbolProvider(languageProvider);
      const flatRequest = service.getFileSymbols(editor);
      const treeRequest = service.getFileSymbolTree(editor);
      try {
        const options = await captureStarted;
        await new Promise((resolve) => setTimeout(resolve, remoteBudget * 3));
        await render();
        const state = service.getDocumentSourceState(editor);
        expect(state.status).toBe("loading");
        expect(state.source.id).toBe("symbol-tree-sitter");
        expect(options.signal.aborted).toBe(false);
        const tile = document.querySelector(".symbol-source-status");
        expect(tile.style.display).toBe("");
        expect(tile.textContent).toBe("TS");
        expect(tile.querySelector("button").getAttribute("aria-label")).toBe(
          "This file uses Tree-sitter symbols.",
        );
        if (failure === "timeout") {
          expect(languageProvider.getDocumentSymbols.calls.first().args[1].signal.aborted).toBe(
            true,
          );
        }
      } finally {
        release();
      }
      const [flat, tree] = await Promise.all([flatRequest, treeRequest]);
      await readySource("symbol-tree-sitter");
      expect(flat?.map((symbol) => symbol.name)).toContain("SlowFallbackSymbols");
      expect(tree?.some((symbol) => symbol.name === "SlowFallbackSymbols")).toBe(true);
      expect(flat?.every((symbol) => symbol.providerId === "symbol-tree-sitter")).toBe(true);
      expect(service.peekFileSymbols(editor)).toBe(flat);
      expect(document.querySelector(".symbol-source-status").textContent).toBe("TS");
      expect(editor.getGrammarQueryCaptureGroups).toHaveBeenCalledTimes(1);
    });
  }
});
