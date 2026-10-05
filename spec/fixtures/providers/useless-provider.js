module.exports = {
  packageName: "symbol-provider-useless",
  name: "Useless",
  canProvideDocumentSymbols: () => false,
  getDocumentSymbols: () => [],
};
