const SymbolListView = require("./symbol-list-view");

const STATUS_MESSAGES = {
  ready: "No matching workspace symbols.",
  unavailable: "No active language backend can search this workspace.",
  starting: "Language backend is starting.",
  partial: "Some language backends could not complete the search.",
  error: "Language backends could not search this workspace.",
};

module.exports = class ProjectView extends SymbolListView {
  constructor(stack, service, window = lumine.workspace.getMainWindow()) {
    super(stack, service, { emptyMessage: STATUS_MESSAGES.ready, window });
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
    const names = symbols.map((symbol) => symbol.name);
    if (
      !this.sourceMatcher ||
      names.length !== this.sourceNames.length ||
      names.some((name, i) => name !== this.sourceNames[i])
    ) {
      this.sourceNames = names;
      this.sourceMatcher = lumine.tools.fuzzyMatcher.setCandidates(names);
    }
    const matches = this.sourceMatcher.match(query, { recordMatchIndexes: true });
    // Keep provider order when normalized scores tie, as the original per-row ranking did.
    matches.sort((left, right) => right.score - left.score || left.id - right.id);
    return matches.map(({ id, matchIndexes }) => {
      const symbol = symbols[id];
      this.sourceMatchIndices.set(symbol, matchIndexes);
      return symbol;
    });
  }

  async destroy() {
    this.sourceMatcher = null;
    this.sourceNames = null;
    this.sourceMatchIndices = null;
    await super.destroy();
  }
};
