const SymbolListView = require("./symbol-list-view");

module.exports = class ProjectView extends SymbolListView {
  constructor(stack, service) {
    // TODO: Do these defaults make sense? Should we allow a provider to
    // override them?
    super(stack, service, {
      emptyMessage: "Project has no symbols or is empty",
      isDynamic: true,
    });

    this.shouldReload = true;
  }

  toggle(filterTerm = "") {
    if (this.isVisible()) {
      this.cancel();
    } else {
      this.populate();
      this.attach();
      this.selectListView.update({ query: filterTerm, selectQuery: true });
    }
  }

  didCancelSelection() {
    this.abortController?.abort();
    super.didCancelSelection();
  }

  didConfirmEmptySelection() {
    this.abortController?.abort();
    super.didConfirmEmptySelection();
  }

  shouldUseCache() {
    let query = this.selectListView?.getQuery();
    if (query && query.length > 0) return false;
    if (this.shouldReload) return false;
    return !!this.cachedSymbols;
  }

  didChangeQuery() {
    this.populate({ retain: true });
  }

  clear() {}

  async populate({ retain = false } = {}) {
    if (this.shouldUseCache()) {
      await this.updateView({ items: this.cachedSymbols });
      return true;
    }

    let query = this.selectListView?.getQuery();

    let listViewOptions = {
      loadingMessage: this.cachedSymbols
        ? `Reloading project symbols…`
        : `Loading project symbols…`,
    };

    if (!this.cachedSymbols) {
      listViewOptions.loadingBadge = 0;
    }

    let editor = lumine.workspace.getActiveTextEditor();

    let start = performance.now();
    this._lastTimestamp = start;
    let anySymbolsLoaded = false;
    let result = this.generateSymbols(editor, query, (symbols) => {
      anySymbolsLoaded = symbols.length > 0;

      // TODO: Should we sort by buffer position? Should we leave it up to the
      // provider? Should we make it configurable?
      let options = {
        ...listViewOptions,
        items: symbols,
        loadingMessage: null,
      };
      this.updateView(options);
    });

    let loadingTimeout;
    if (retain) {
      loadingTimeout = setTimeout(
        (timestamp) => {
          if (timestamp !== this._lastTimestamp) return;
          if (anySymbolsLoaded) return;
          this.updateView({ loadingMessage: `Reloading project symbols…` });
        },
        500,
        start,
      );
    }

    if (result?.then) result = await result;
    clearTimeout(loadingTimeout);
    if (result == null) {
      result = [];
    }

    this.cachedSymbols = result;

    // TODO: We assume that project-wide symbol search will involve re-querying
    // the language server whenever the user types another character. This
    // distinguishes it from searching within one buffer — where typing in the
    // query field just filters a static list.
    //
    // This is a safe assumption to make, but we could at least make it
    // possible for a provider to return a static list and somehow indicate
    // that it’s static so that we don’t have to keep re-querying.
    this.shouldReload = true;
    return true;
  }

  async generateSymbols(editor, query = "", callback) {
    this.abortController?.abort();
    this.abortController = new AbortController();

    let symbols = await this.service.searchProject(editor, query, {
      signal: this.abortController.signal,
      onSymbols: callback,
      listController: this.listController,
    });
    if (symbols == null) return null;

    this.cachedSymbols = symbols;
    return symbols;
  }
};
