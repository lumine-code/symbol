const SymbolListView = require("./symbol-list-view");

const STATUS_MESSAGES = {
  ready: "No matching workspace symbols.",
  unavailable: "No active language backend can search this workspace.",
  starting: "Language backend is starting.",
  partial: "Some language backends could not complete the search.",
  error: "Language backends could not search this workspace.",
};

module.exports = class ProjectView extends SymbolListView {
  constructor(stack, service) {
    super(stack, service, { emptyMessage: STATUS_MESSAGES.ready });
    this.selectList.setSource({
      mode: "query",
      debounceMs: 200,
      loadingMessage: "Searching workspace symbols…",
      load: (request) => this.loadProjectSymbols(request),
    });
    this.disposables.add(
      service.onDidInvalidateWorkspaceSymbols(() => {
        if (this.isVisible()) this.selectList.reload();
      }),
    );
  }

  toggle(filterTerm = "") {
    if (this.isVisible()) return this.cancel();
    return this.attach({ query: filterTerm, selectQuery: true });
  }

  setRequestStatus({ state }) {
    const message = STATUS_MESSAGES[state] ?? STATUS_MESSAGES.error;
    this.selectList.update({
      emptyMessage: message,
      infoMessage: state === "ready" ? "Symbols from active language backends" : message,
    });
  }

  async loadProjectSymbols({ query, signal, publish }) {
    const result = await this.service.searchWorkspace(query, {
      signal,
      onSymbols: (symbols) => {
        if (!signal.aborted) publish(this.filterProjectSymbols(symbols, query));
      },
      onStatus: (status) => {
        if (!signal.aborted) this.setRequestStatus(status);
      },
    });
    if (signal.aborted) return undefined;
    return this.filterProjectSymbols(result ?? [], query);
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
