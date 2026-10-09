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
          this.createProjectView().toggle(text);
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
          this.createFileView().toggle(text);
        },
      },
      "symbol:go-to-definition": {
        description: "Jump to where the symbol under the cursor is defined.",
        didDispatch: () => {
          if (!this.ensureProvidersExist("definition")) return;
          this.createGoToView().toggle();
        },
      },
      "symbol:return-from-definition": {
        description: "Go back to where the last definition jump started.",
        didDispatch: () => {
          this.createGoBackView().toggle();
        },
      },
    });
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
      this.sourceListView,
      this.fileView,
      this.projectView,
      this.goToView,
      this.goBackView,
      ...(this.sourceStatusViews ?? []),
    ].filter(Boolean);
    const registry = this.registry;
    const providerLeases = this.providerLeases;
    const workspaceSubscription = this.workspaceSubscription;
    const editorSubscription = this.editorSubscription;
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

  consumeStatusBar(statusBar) {
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
        const view = new SourceStatusView(statusBar, this.service, (editor) => {
          if (this.registry === registry && !registry.destroyed)
            this.showDocumentSourceSelector(editor);
        });
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

  showDocumentSourceSelector(target) {
    const editor = target?.getGrammar
      ? target
      : (target?.target?.closest?.("lumine-text-editor:not([mini])")?.getModel?.() ??
        lumine.workspace.getActiveEmbeddedTextEditor());
    if (!editor || editor.isDestroyed()) return;
    const SourceListView = require("./source-list-view");
    this.sourceListView ??= new SourceListView(this.service);
    return this.sourceListView.toggle(editor);
  },

  createFileView() {
    if (this.fileView) return this.fileView;

    const FileView = require("./file-view");
    this.fileView = new FileView(this.stack, this.service);
    return this.fileView;
  },

  createProjectView() {
    if (this.projectView) return this.projectView;

    const ProjectView = require("./project-view");
    this.projectView = new ProjectView(this.stack, this.service);
    return this.projectView;
  },

  createGoToView() {
    if (this.goToView) return this.goToView;

    const GoToView = require("./go-to-view");
    this.goToView = new GoToView(this.stack, this.service);
    return this.goToView;
  },

  createGoBackView() {
    if (this.goBackView) return this.goBackView;

    const GoBackView = require("./go-back-view");
    this.goBackView = new GoBackView(this.stack, this.service);
    return this.goBackView;
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
