const { CompositeDisposable, Disposable } = require("lumine");

module.exports = class SourceStatusView {
  constructor(statusBar, registry, onShow) {
    this.statusBar = statusBar;
    this.registry = registry;
    this.onShow = onShow;
    this.destroyed = false;
    this.enabled = true;
    this.readySources = new WeakMap();
    this.subscriptions = new CompositeDisposable();
    this.editorSubscriptions = new CompositeDisposable();

    this.element = document.createElement("status-bar-tile");
    this.element.classList.add("symbol-source-status");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.classList.add("symbol-source-button");
    this.button.setAttribute("aria-haspopup", "dialog");
    this.element.appendChild(this.button);
    this.tooltipContent = document.createElement("div");
    this.tooltip = lumine.tooltips.add(this.element, { item: this.tooltipContent });

    const click = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // The picker can move focus to its mini editor. Keep the editor this
      // tile describes, including an active notebook cell, as the target.
      const editor = this.editor;
      if (editor && !editor.isDestroyed()) this.onShow(editor);
    };
    const preserveEditorFocus = (event) => {
      if (event.button === 0) event.preventDefault();
    };
    this.element.addEventListener("click", click);
    this.element.addEventListener("mousedown", preserveEditorFocus);
    this.subscriptions.add(
      new Disposable(() => this.element.removeEventListener("click", click)),
      new Disposable(() => this.element.removeEventListener("mousedown", preserveEditorFocus)),
      registry.onDidChangeDocumentSource(({ editor }) => {
        if (!editor || editor === this.editor) this.update();
      }),
      registry.onDidInvalidateFileSymbols(({ editor }) => {
        if (!editor || editor === this.editor) {
          this.update();
          this.fetch();
        }
      }),
      lumine.config.observe("symbol.showStatusBarItem", (enabled) => {
        this.enabled = enabled !== false;
        this.attach();
        this.update();
      }),
      lumine.config.observe("grammar-selector.showOnRightSideOfStatusBar", () => this.attach()),
      lumine.workspace.observeActiveEmbeddedTextEditor(() => this.observeEditor()),
    );
  }

  attach() {
    if (this.destroyed) return;
    this.tile?.destroy();
    this.tile = null;
    if (!this.enabled) return;
    // Directly after the grammar tile in either file-identity band.
    this.tile = lumine.config.get("grammar-selector.showOnRightSideOfStatusBar")
      ? this.statusBar.addRightTile({ item: this.element, priority: 405 })
      : this.statusBar.addLeftTile({ item: this.element, priority: 330 });
  }

  observeEditor() {
    if (this.destroyed) return;
    const active = lumine.workspace.getActiveEmbeddedTextEditor();
    const editor = active && !active.isDestroyed() ? active : null;
    if (editor === this.editor) return;
    this.editorSubscriptions.dispose();
    this.editorSubscriptions = new CompositeDisposable();
    this.editor = editor;
    if (editor) {
      this.editorSubscriptions.add(
        editor.onDidChangeGrammar(() => {
          this.update();
          this.fetch();
        }),
        editor.onDidDestroy(() => this.observeEditor()),
      );
    }
    this.update();
    this.fetch();
  }

  fetch() {
    const editor = this.editor;
    if (this.destroyed || !this.enabled || !editor || editor.isDestroyed()) return;
    // Share the registry's cache and in-flight request with every consumer.
    // Do not fetch every source just to display the source selector.
    Promise.resolve(this.registry.getFileSymbols(editor)).then(
      () => {
        if (!this.destroyed && this.editor === editor) this.update();
      },
      () => {
        if (!this.destroyed && this.editor === editor) this.update();
      },
    );
  }

  titleForState(state) {
    const name = state.source?.name;
    if (state.status === "ready" && name) return `This file uses ${name} symbols`;
    let title;
    if (state.status === "error") {
      title = name
        ? `Could not load ${name} symbols for this file.`
        : "Could not load symbols for this file.";
    } else if (state.status === "unavailable" || state.status === "ready") {
      title = name
        ? `${name} symbols are unavailable for this file.`
        : "No symbol source is available for this file.";
    } else if (state.status === "starting" && name) {
      title = `Waiting for ${name} symbols for this file…`;
    } else {
      title = "Loading symbols for this file…";
    }
    return (state.message ? `${title} ${state.message}` : title).replace(/\.$/, "");
  }

  update() {
    if (this.destroyed) return;
    this.updateSubscription?.dispose();
    this.updateSubscription = lumine.views.updateDocument(() => {
      this.updateSubscription = null;
      if (this.destroyed) return;
      const editor = this.editor;
      this.element.style.display = this.enabled && editor && !editor.isDestroyed() ? "" : "none";
      if (!editor || editor.isDestroyed()) return;
      const state = this.registry.getDocumentSourceState(editor);
      const pending = ["idle", "loading", "starting"].includes(state.status);
      const grammar = editor.getGrammar();
      const previous = this.readySources.get(editor);
      if (state.status === "ready" && state.source) {
        this.readySources.set(editor, { grammar, source: state.source });
      }
      const source = pending
        ? state.source || (previous?.grammar === grammar ? previous.source : null)
        : state.source;
      const label =
        state.status === "ready" || pending ? source?.shortLabel || (pending ? "" : "—") : "—";
      if (pending && !label) this.element.style.display = "none";
      const title =
        pending && source
          ? this.titleForState({ source, status: "ready" })
          : this.titleForState(state);
      this.button.textContent = label;
      this.button.setAttribute("aria-label", title);
      this.element.dataset.status = state.status;
      this.element.dataset.mode = state.mode;
      this.tooltipContent.textContent = title;
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.updateSubscription?.dispose();
    this.updateSubscription = null;
    this.subscriptions.dispose();
    this.editorSubscriptions.dispose();
    this.tile?.destroy();
    this.tile = null;
    this.tooltip?.dispose();
    this.tooltip = null;
    this.editor = null;
    this.element.remove();
  }
};
