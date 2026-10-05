module.exports = {
  packageName: "symbol-provider-empty",
  name: "Empty",
  canProvideDocumentSymbols: () => true,
  getDocumentSymbols: () => [],
  searchWorkspaceSymbols: () => [],
  canProvideDefinitions: () => true,
  getDefinitions: () => [],
};
