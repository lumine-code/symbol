const SymbolListView = require("./symbol-list-view");

module.exports = class ProjectView extends SymbolListView {
  constructor(stack, service) {
    // TODO: Do these defaults make sense? Should we allow a provider to
    // override them?
    super(stack, service, {
      emptyMessage: "Project has no symbols or is empty",
    });

    this.shouldReload = true;
    this.selectList.setSource({
      mode: "query",
      loadingMessage: "Loading project symbols…",
      load: (request) => this.loadProjectSymbols(request),
    });
  }

  toggle(filterTerm = "") {
    if (this.isVisible()) {
      return this.cancel();
    }
    return this.attach({ query: filterTerm, selectQuery: true });
  }

  shouldUseCache() {
    let query = this.selectList.getQuery();
    if (query && query.length > 0) return false;
    if (this.shouldReload) return false;
    return !!this.cachedSymbols;
  }

  clear() {}

  async loadProjectSymbols({ query, signal, publish }) {
    if (this.shouldUseCache()) {
      return this.cachedSymbols;
    }

    let editor = lumine.workspace.getActiveTextEditor();
    let result = await this.service.searchProject(editor, query, {
      signal,
      onSymbols: (symbols) => {
        this.cachedSymbols = symbols;
        return publish(this.filterProjectSymbols(symbols, query));
      },
      listController: this.listController,
    });
    if (signal.aborted) return undefined;
    result ??= [];

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
    return this.filterProjectSymbols(result, query);
  }

  filterProjectSymbols(symbols, query) {
    this.sourceMatchIndices = new WeakMap();
    if (!query) return symbols;

    const matches = [];
    for (const symbol of symbols) {
      const match = lumine.tools.fuzzyMatcher.match(symbol.name, query, {
        recordMatchIndexes: true,
      });
      if (!match) continue;
      this.sourceMatchIndices.set(symbol, match.matchIndexes);
      matches.push({ symbol, score: match.score });
    }
    matches.sort((left, right) => right.score - left.score);
    return matches.map(({ symbol }) => symbol);
  }
};
