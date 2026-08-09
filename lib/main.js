const { Disposable } = require("lumine");
const Config = require("./config");
const Registry = require("./registry");
const Path = require("path");

const NO_PROVIDERS_MESSAGE = `You don’t have any symbol providers installed.`;
const NO_PROVIDERS_DESCRIPTION = `The button below will show all packages that can provide symbols.

At minimum, we recommend you enable the following bundled packages:

* \`symbol-tree-sitter\`
* \`symbol-ctags\`
`;

// The outward-facing `symbol.registry` service. One frozen object, built
// once: ServiceHub may ask more than once, and two consumers comparing
// payload members must see the same functions. The hub's own pickers consume
// this same object, so the outward API is proven sufficient by the package's
// own UI. Provider registration is deliberately absent — that is
// `symbol.provider`'s job, and exposing it here would let a registry consumer
// smuggle providers past ServiceHub.
function buildService(registry) {
  return Object.freeze({
    getFileSymbols: (editor, options) => registry.getFileSymbols(editor, options),
    peekFileSymbols: (editor) => registry.peekFileSymbols(editor),
    onDidInvalidateFileSymbols: (callback) => registry.onDidInvalidateFileSymbols(callback),
    searchProject: (editor, query, options) => registry.searchProject(editor, query, options),
    findDeclarations: (editor, options) => registry.findDeclarations(editor, options),
    providers: () => registry.providerDescriptors(),
    onDidChangeProviders: (callback) => registry.onDidChangeProviders(callback),
  });
}

module.exports = {
  activate() {
    Config.activate();
    this.stack = [];
    this.registry = new Registry();
    this.service = buildService(this.registry);

    this.workspaceSubscription = lumine.commands.add("lumine-workspace", {
      "symbol:toggle-project-symbols": (event) => {
        if (!this.ensureProvidersExist()) {
          event.abortKeyBinding();
          return;
        }
        let text = this.getSelectedTextIfEnabled(event);
        this.createProjectView().toggle(text);
      },
      "symbol:show-active-providers": () => {
        this.showActiveProviders();
      },
    });

    this.editorSubscription = lumine.commands.add("lumine-text-editor:not([mini])", {
      "symbol:toggle-file-symbols": (event) => {
        if (!this.ensureProvidersExist()) {
          event.abortKeyBinding();
          return;
        }
        let text = this.getSelectedTextIfEnabled(event);
        this.createFileView().toggle(text);
      },
      "symbol:go-to-declaration": () => {
        if (!this.ensureProvidersExist()) return;
        this.createGoToView().toggle();
      },
      "symbol:return-from-declaration": () => {
        if (!this.ensureProvidersExist()) return;
        this.createGoBackView().toggle();
      },
    });
  },

  getSelectedTextIfEnabled(event) {
    let editorView = event.target.closest("lumine-text-editor");
    if (!editorView) return "";
    let editor = editorView.getModel();
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

  deactivate() {
    this.fileView?.destroy();
    this.fileView = null;

    this.projectView?.destroy();
    this.projectView = null;

    this.goToView?.destroy();
    this.goToView = null;

    this.goBackView?.destroy();
    this.goBackView = null;

    this.workspaceSubscription?.dispose();
    this.workspaceSubscription = null;

    this.editorSubscription?.dispose();
    this.editorSubscription = null;

    this.registry?.destroy();
    this.registry = null;
    this.service = null;
  },

  consumeSymbol(provider) {
    if (Array.isArray(provider)) {
      this.registry.addProviders(...provider);
    } else {
      this.registry.addProviders(provider);
    }

    return new Disposable(() => {
      if (Array.isArray(provider)) {
        this.registry?.removeProviders(...provider);
      } else {
        this.registry?.removeProviders(provider);
      }
    });
  },

  provideSymbolRegistry() {
    return (this.service ??= buildService(this.registry));
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
      .map((p) => `* **${p.name}** provided by \`${p.packageName}\``)
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

  ensureProvidersExist() {
    if (this.registry.hasProviders()) return true;

    lumine.notifications.addWarning(NO_PROVIDERS_MESSAGE, {
      description: NO_PROVIDERS_DESCRIPTION,
      dismissable: true,
    });

    return false;
  },

  // A `hyperclick.provider` implementation that works similarly to the
  // `symbol:go-to-declaration` command.
  provideHyperclick() {
    return {
      priority: 1,
      providerName: "symbol",
      getSuggestionForWord: async (editor, _text, range) => {
        let symbols = await this.service.findDeclarations(editor, { range });
        let editorPath = editor.getPath();
        if (!symbols || symbols.length === 0) return;

        // If we're at the definition site, the only result will be a symbol
        // whose position is identical to the position we asked about. Filter
        // it out. In that situation, we don't want a hyperclick affordance at
        // all.
        symbols = symbols.filter((sym) => {
          let { path, directory, file } = sym;
          if (!path) {
            path = Path.join(directory, file);
          }
          return path !== editorPath || sym.position.compare(range.start) !== 0;
        });
        if (symbols.length === 0) return;

        return {
          range,
          callback: () => {
            editor.setSelectedBufferRange(range);
            this.createGoToView().toggle();
          },
        };
      },
    };
  },
};
