module.exports = {
  packageName: "symbol-provider-empty",
  name: "Empty",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 1, state: "ready" }]; },
  getDocumentSymbols: () => [],
  searchWorkspaceSymbols: () => [],
  canProvideDefinitions: () => true,
  getDefinitions: () => [],
};
