const { CompositeDisposable, Disposable } = require("lumine");
const Config = require("./config");
const Registry = require("./registry");
const Path = require("path");

const NO_PROVIDERS_MESSAGE = "Symbol information is unavailable for this document.";
const NO_PROVIDERS_DESCRIPTION =
  "Enable symbol-tree-sitter for buffer symbols or a language backend for definitions.";

// The outward-facing `symbol.registry` service. One frozen object, built
// once: ServiceHub may ask more than once, and two consumers comparing
// payload members must see the same functions. The hub's own pickers consume
// this same object, so the outward API is proven sufficient by the package's
// own UI. Provider registration is deliberately absent — that is
// the role-specific provider services' job; exposing it here would let a consumer
// smuggle providers past ServiceHub.
function buildService(registry) {
  return Object.freeze({
    getFileSymbols: (editor) => registry.getFileSymbols(editor),
    peekFileSymbols: (editor) => registry.peekFileSymbols(editor),
    getFileSymbolTree: (editor) => registry.getFileSymbolTree(editor),
    peekFileSymbolTree: (editor) => registry.peekFileSymbolTree(editor),
    onDidInvalidateFileSymbols: (callback) => registry.onDidInvalidateFileSymbols(callback),
    searchWorkspace: (query, options) => registry.searchWorkspace(query, options),
    onDidInvalidateWorkspaceSymbols: (callback) =>
      registry.onDidInvalidateWorkspaceSymbols(callback),
    findDefinitions: (editor, options) => registry.findDefinitions(editor, options),
    providers: () => registry.providerDescriptors(),
    onDidChangeProviders: (callback) => registry.onDidChangeProviders(callback),
    listDocumentSources: (editor) => registry.listDocumentSources(editor),
    getDocumentSourceState: (editor) => registry.getDocumentSourceState(editor),
    setDocumentSource: (editor, sourceId, options) =>
      registry.setDocumentSource(editor, sourceId, options),
    onDidChangeDocumentSource: (callback) => registry.onDidChangeDocumentSource(callback),
  });
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "symbol",
      tips: [
        "You can jump to any function or symbol in the current file using {{ 'symbol:toggle-file-symbols' | keystroke }}",
        "{% if keys['symbol:select-document-source'] %}Choose this file's symbol source with {{ 'symbol:select-document-source' | keystroke }}{% else %}Use Symbol: Select Document Source to choose symbols for this file or its grammar. The TS or LS item beside the grammar name opens the same selector.{% endif %}",
      ],
    };
  },

  activate(state = {}) {
    Config.activate();
    this.stack = [];
    this.windowViews = new Map();
    this.registry = new Registry(state);
    this.service = buildService(this.registry);
    this.sourceStatusViews = new Set();
    this.providerLeases = new CompositeDisposable();
    this.providerConnections = {
      document: new Map(),
      workspace: new Map(),
      definition: new Map(),
    };
    this.statusConnections = new Map();

    this.workspaceSubscription = lumine.commands.add("lumine-workspace", {
      "symbol:select-document-source": {
        description: "Choose the symbol source for this file or its grammar.",
        didDispatch: (event) => this.showDocumentSourceSelector(event),
      },
      "symbol:toggle-project-symbols": {
        description: "Search symbols supplied by active language backends.",
        didDispatch: (event) => {
          let text = this.getSelectedTextIfEnabled(event);
          this.createProjectView(event.context?.window).toggle(text);
        },
      },
      "symbol:show-active-providers": {
        description: "Report which packages are supplying symbols right now.",
        didDispatch: () => {
          this.showActiveProviders();
        },
      },
    });

    this.editorSubscription = lumine.commands.add("lumine-text-editor:not([mini])", {
      "symbol:toggle-file-symbols": {
        description: "List the symbols of this file and jump to one.",
        didDispatch: (event) => {
          if (!this.ensureProvidersExist("document")) {
            event.abortKeyBinding();
            return;
          }
          let text = this.getSelectedTextIfEnabled(event);
          return this.createFileView(event.context?.window).toggle(text, this.commandEditor(event));
        },
      },
      "symbol:go-to-definition": {
        description: "Jump to where the symbol under the cursor is defined.",
        didDispatch: (event) => {
          if (!this.ensureProvidersExist("definition")) return;
          return this.createGoToView(event.context?.window).toggle(this.commandEditor(event));
        },
      },
      "symbol:return-from-definition": {
        description: "Go back to where the last definition jump started.",
        didDispatch: (event) => {
          this.createGoBackView(event.context?.window).toggle();
        },
      },
    });
  },

  commandEditor(event) {
    return (
      lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false }) ??
      (event?.context
        ? event.context.embeddedEditor
        : lumine.workspace.getActiveEmbeddedTextEditor())
    );
  },

  getSelectedTextIfEnabled(event) {
    const editor = lumine.workspace.getTextEditorForElement(event?.target, {
      includeMini: false,
    });
    if (!editor) return "";
    let selection = editor.getLastSelection();

    // Don't use the selection if it spans more than one buffer line.
    let range = selection.getBufferRange();
    if (range.start.row !== range.end.row) return "";

    // Don't use the selection unless the associated config option is enabled.
    let prefill = lumine.config.get("symbol.prefillSelectedText", {
      scope: [editor.getGrammar()?.scopeName],
    });
    return prefill ? editor.getSelectedText() : "";
  },

  async deactivate() {
    const views = [
      ...[...(this.windowViews?.values() ?? [])].flatMap((state) => Object.values(state.views)),
      ...(this.sourceStatusViews ?? []),
    ].filter(Boolean);
    const registry = this.registry;
    const providerLeases = this.providerLeases;
    const workspaceSubscription = this.workspaceSubscription;
    const editorSubscription = this.editorSubscription;
    this.windowViews?.clear();
    this.sourceListView = null;
    this.sourceStatusViews?.clear();
    this.fileView = null;
    this.projectView = null;
    this.goToView = null;
    this.goBackView = null;
    this.workspaceSubscription = null;
    this.editorSubscription = null;
    this.registry = null;
    this.service = null;
    this.providerLeases = null;
    for (const connections of Object.values(this.providerConnections ?? {})) connections.clear();
    this.statusConnections?.clear();
    Config.deactivate();
    const destroying = views.map((view) => view.destroy());
    try {
      providerLeases?.dispose();
      workspaceSubscription?.dispose();
      editorSubscription?.dispose();
      registry?.destroy();
    } finally {
      await Promise.all(destroying);
    }
  },

  serialize() {
    return this.registry?.serialize() ?? { documentSources: [] };
  },

  restoreState(state) {
    this.registry?.restoreSessionState(state);
  },

  consumeDocumentSymbolProvider(provider) {
    return this.consumeProvider("document", provider);
  },
  consumeWorkspaceSymbolProvider(provider) {
    return this.consumeProvider("workspace", provider);
  },
  consumeDefinitionProvider(provider) {
    return this.consumeProvider("definition", provider);
  },
  consumeProvider(role, supplied) {
    const providers = Array.isArray(supplied) ? supplied : [supplied];
    const registry = this.registry;
    const connections = this.providerConnections?.[role];
    const owner = this.providerLeases;
    if (!registry || registry.destroyed || !connections || !owner) return new Disposable();
    const leases = providers.map((provider) => {
      let record = connections.get(provider);
      const fresh = !record;
      if (!record) {
        record = { references: 0 };
        connections.set(provider, record);
      }
      record.references++;
      const lease = new Disposable(() => {
        owner.remove(lease);
        if (connections.get(provider) !== record) return;
        if (--record.references === 0) {
          connections.delete(provider);
          registry.broker.remove(role, provider);
        }
      });
      owner.add(lease);
      try {
        if (fresh) registry.broker.add(role, provider);
      } catch (error) {
        lease.dispose();
        throw error;
      }
      return lease;
    });
    return new CompositeDisposable(...leases);
  },
  provideSymbolRegistry() {
    return (this.service ??= buildService(this.registry));
  },

  consumeStatusBar(service) {
    return service.observeWindows(
      (scopedStatusBar, context) => this.consumeWindowStatusBar(scopedStatusBar, context),
      { windows: "all" },
    );
  },

  consumeWindowStatusBar(statusBar, context) {
    const registry = this.registry;
    const connections = this.statusConnections;
    const views = this.sourceStatusViews;
    const owner = this.providerLeases;
    if (!registry || registry.destroyed || !owner) return new Disposable();
    const SourceStatusView = require("./source-status-view");
    let record = connections.get(statusBar);
    const fresh = !record;
    if (!record) {
      record = { references: 0, view: null };
      connections.set(statusBar, record);
    }
    record.references++;
    const lease = new Disposable(() => {
      owner.remove(lease);
      if (connections.get(statusBar) !== record) return;
      if (--record.references === 0) {
        connections.delete(statusBar);
        views.delete(record.view);
        record.view?.destroy();
      }
    });
    owner.add(lease);
    try {
      if (fresh) {
        const view = new SourceStatusView(
          statusBar,
          this.service,
          (editor) => {
            if (this.registry === registry && !registry.destroyed)
              this.showDocumentSourceSelector(editor, context.window);
          },
          context,
        );
        if (
          this.registry !== registry ||
          registry.destroyed ||
          connections.get(statusBar) !== record
        ) {
          view.destroy();
          lease.dispose();
          return new Disposable();
        }
        record.view = view;
        views.add(view);
        view.attach();
      }
    } catch (error) {
      lease.dispose();
      throw error;
    }
    return lease;
  },

  windowState(window = lumine.workspace.getMainWindow()) {
    let state = this.windowViews.get(window);
    if (!state) {
      const states = this.windowViews;
      state = { views: {}, stack: window.isMain() ? this.stack : [] };
      states.set(window, state);
      this.providerLeases.add(
        window.onWillDestroy(() => {
          states.delete(window);
          for (const view of Object.values(state.views)) void view.destroy();
        }),
      );
    }
    return state;
  },

  showDocumentSourceSelector(target, window) {
    const editor = target?.getGrammar ? target : this.commandEditor(target);
    if (!editor || editor.isDestroyed()) return;
    window ??=
      target?.context?.window ??
      lumine.workspace.getWindowForElement(editor.getElement()) ??
      lumine.workspace.getMainWindow();
    const state = this.windowState(window);
    const SourceListView = require("./source-list-view");
    state.views.sourceListView ??= new SourceListView(this.service, window);
    if (window.isMain()) this.sourceListView = state.views.sourceListView;
    return state.views.sourceListView.toggle(editor);
  },

  createFileView(window = lumine.workspace.getMainWindow()) {
    const state = this.windowState(window);
    const FileView = require("./file-view");
    state.views.fileView ??= new FileView(state.stack, this.service, window);
    if (window.isMain()) this.fileView = state.views.fileView;
    return state.views.fileView;
  },

  createProjectView(window = lumine.workspace.getMainWindow()) {
    const state = this.windowState(window);
    const ProjectView = require("./project-view");
    state.views.projectView ??= new ProjectView(state.stack, this.service, window);
    if (window.isMain()) this.projectView = state.views.projectView;
    return state.views.projectView;
  },

  createGoToView(window = lumine.workspace.getMainWindow()) {
    const state = this.windowState(window);
    const GoToView = require("./go-to-view");
    state.views.goToView ??= new GoToView(state.stack, this.service, { window });
    if (window.isMain()) this.goToView = state.views.goToView;
    return state.views.goToView;
  },

  createGoBackView(window = lumine.workspace.getMainWindow()) {
    const state = this.windowState(window);
    const GoBackView = require("./go-back-view");
    state.views.goBackView ??= new GoBackView(state.stack, this.service, { window });
    if (window.isMain()) this.goBackView = state.views.goBackView;
    return state.views.goBackView;
  },

  showActiveProviders() {
    let message = this.service
      .providers()
      .map((p) => `* **${p.name}** (${p.role}) provided by \`${p.packageName}\``)
      .join("\n");

    lumine.notifications.addInfo("Symbol providers", {
      description: message,
      dismissable: true,
      buttons: [
        {
          text: "Copy",
          onDidClick() {
            lumine.clipboard.write(message);
          },
        },
      ],
    });
  },

  ensureProvidersExist(role) {
    if (this.registry.hasProviders(role)) return true;

    lumine.notifications.addWarning(NO_PROVIDERS_MESSAGE, {
      description: NO_PROVIDERS_DESCRIPTION,
      dismissable: true,
    });

    return false;
  },

  // A `hyperclick.provider` implementation that works similarly to the
  // `symbol:go-to-definition` command.
  provideHyperclick() {
    return {
      priority: 1,
      providerName: "symbol",
      getSuggestionForWord: async (editor, _text, range) => {
        let symbols = await this.service.findDefinitions(editor, { range });
        let editorPath = editor.getPath();
        if (!symbols || symbols.length === 0) return;

        // If we're at the definition site, the only result will be a symbol
        // whose position is identical to the position we asked about. Filter
        // it out. In that situation, we don't want a hyperclick affordance at
        // all.
        symbols = symbols.filter((sym) => {
          let { path, directory, file } = sym;
          if (!path) path = directory && file ? Path.join(directory, file) : editorPath;
          const sameDocument =
            sym.cell && sym.uri ? sym.uri === editor.getURI() : path === editorPath;
          return !sameDocument || sym.position.compare(range.start) !== 0;
        });
        if (symbols.length === 0) return;

        return {
          range,
          callback: () => {
            editor.setSelectedBufferRange(range);
            return this.createGoToView().presentSymbols(editor, symbols);
          },
        };
      },
    };
  },
};
