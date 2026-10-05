const { CompositeDisposable } = require("lumine");

const AUTO_ID = "symbol:auto";
const SOURCE_MESSAGES = {
  starting: "The source is starting.",
  unavailable: "The source is unavailable for this document.",
  error: "The source could not provide symbols.",
};

module.exports = class SourceListView {
  constructor(registry) {
    this.registry = registry;
    this.generation = 0;
    this.destroyed = false;
    this.disposables = new CompositeDisposable();
    this.editorSubscriptions = new CompositeDisposable();
    this.auto = { id: AUTO_ID, name: "Auto detect", state: "ready", score: 1 };
    this.selectListHost = lumine.workspace.addSelectList(
      {
        itemsClassList: ["mark-active"],
        items: [],
        getItemId: (source) => source.id,
        search: { getFilterText: (source) => source.name },
        renderItem: (source, { highlight }) => this.renderItem(source, highlight),
        commands: {
          "symbol:use-document-source": {
            description: "Use the selected symbol source for this file.",
            didDispatch: ({ detail }) => this.useSource(detail.item),
          },
          "symbol:use-document-source-for-grammar": {
            description: "Save the selected symbol source for this grammar.",
            didDispatch: ({ detail }) => this.useSource(detail.item, { scope: "grammar" }),
          },
        },
        actions: [
          {
            command: "symbol:use-document-source",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
            when: ({ item }) => item != null,
            enabled: ({ item }) => this.canUse(item),
            disabledReason: ({ item }) => this.description(item),
          },
          {
            command: "symbol:use-document-source-for-grammar",
            context: "item",
            disposition: "close",
            dispatch: "local",
            when: ({ item }) => item != null,
            enabled: ({ item }) => this.canUse(item),
            disabledReason: ({ item }) => this.description(item),
          },
        ],
      },
      { className: "symbol-source-selector", crumb: "Symbol Source" },
    );
    this.selectList = this.selectListHost.getModel();
    this.disposables.add(
      this.selectListHost.onDidHide(() => this.clearEditor()),
      registry.onDidChangeDocumentSource(({ editor }) => {
        if (this.editor && (!editor || editor === this.editor)) void this.refresh();
      }),
      registry.onDidChangeProviders(() => {
        if (this.editor) void this.refresh();
      }),
    );
  }

  canUse(source) {
    return !!source && (source === this.auto || (source.score > 0 && source.state === "ready"));
  }

  description(source) {
    if (source === this.auto) {
      return undefined;
    }
    return source?.message || SOURCE_MESSAGES[source?.state];
  }

  renderItem(source, highlight) {
    const selected =
      this.state?.mode === "manual" ? this.state.sourceId === source.id : source === this.auto;
    const automaticResult =
      this.state?.mode === "auto" &&
      this.state.status === "ready" &&
      this.state.source?.id === source.id;
    return {
      className: [
        "symbol-source-item",
        selected && "active",
        automaticResult && "auto-selected",
        !this.canUse(source) && "unavailable",
      ].filter(Boolean),
      primary: highlight(source.name),
      secondary: this.description(source),
      trailing: source.shortLabel
        ? [{ text: source.shortLabel, className: "badge badge-info" }]
        : [],
      didRender: (element) => {
        element.dataset.sourceId = source.id;
        element.setAttribute("aria-disabled", String(!this.canUse(source)));
      },
    };
  }

  clearEditor() {
    this.generation++;
    this.editor = null;
    this.state = null;
    this.selectCurrentOnRefresh = false;
    this.editorSubscriptions.dispose();
    this.editorSubscriptions = new CompositeDisposable();
  }

  currentSource(sources) {
    const id =
      this.state?.mode === "manual"
        ? this.state.sourceId
        : this.state?.status === "ready"
          ? this.state.source?.id
          : null;
    if (!id) return null;
    return (
      sources.find((source) => source.id === id) ?? {
        ...(this.state.source?.id === id ? this.state.source : { id, name: id }),
        state: "unavailable",
        score: 0,
        message: "This source is unavailable for this document.",
      }
    );
  }

  async refresh() {
    const editor = this.editor;
    if (this.destroyed || !editor || editor.isDestroyed()) return;
    const generation = ++this.generation;
    try {
      const sources = await this.registry.listDocumentSources(editor);
      if (
        this.destroyed ||
        generation !== this.generation ||
        editor !== this.editor ||
        editor.isDestroyed()
      )
        return;
      this.state = this.registry.getDocumentSourceState(editor);
      const current = this.currentSource(sources);
      const available = sources.filter(
        (source) =>
          source.id === current?.id ||
          source.id === "symbol-tree-sitter" ||
          (source.state === "ready" && source.score > 0),
      );
      if (current && !available.some((source) => source.id === current.id)) available.push(current);
      const selectCurrent = this.selectCurrentOnRefresh && !this.selectList.getQuery();
      this.selectCurrentOnRefresh = false;
      await this.selectList.update({
        items: [this.auto, ...available],
        overflowSections: [
          { id: "current", items: current ? [this.auto, current] : [this.auto] },
          { id: "sources", items: available.filter((source) => source.id !== current?.id) },
        ],
        ...(selectCurrent && {
          itemUpdateOptions: {
            selection: { id: this.state.mode === "manual" ? (current?.id ?? AUTO_ID) : AUTO_ID },
          },
        }),
        loadingMessage: null,
        errorMessage: null,
      });
    } catch {
      if (this.destroyed || generation !== this.generation || editor !== this.editor) return;
      await this.selectList.update({
        items: [this.auto],
        overflowSections: null,
        loadingMessage: null,
        errorMessage: "Unable to list symbol sources.",
      });
    }
  }

  async toggle(editor) {
    if (this.destroyed) return;
    if (this.selectListHost.isVisible() || this.editor) {
      this.selectListHost.cancel();
      this.clearEditor();
      return;
    }
    if (!editor || editor.isDestroyed()) return;
    this.editor = editor;
    this.state = this.registry.getDocumentSourceState(editor);
    this.selectCurrentOnRefresh = true;
    this.editorSubscriptions.add(
      editor.onDidDestroy(() => this.selectListHost.cancel()),
      editor.onDidChangeGrammar(() => void this.refresh()),
    );
    await this.selectList.update({
      items: [this.auto],
      overflowSections: null,
      loadingMessage: "Loading symbol sources…",
      errorMessage: null,
    });
    if (this.destroyed || this.editor !== editor || editor.isDestroyed()) return;
    this.selectListHost.show();
    await this.refresh();
  }

  useSource(source, options) {
    const editor = this.editor;
    if (!this.canUse(source) || !editor || editor.isDestroyed()) return;
    const id = source === this.auto ? null : source.id;
    if (options) this.registry.setDocumentSource(editor, id, options);
    else this.registry.setDocumentSource(editor, id);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearEditor();
    this.disposables.dispose();
    return this.selectListHost.destroy();
  }
};
