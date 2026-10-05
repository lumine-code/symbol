module.exports = {
  packageName: "symbol-provider-hanging",
  name: "Hanging",
  canProvideDocumentSymbols: () => new Promise(() => {}),
  getDocumentSymbols: () => [],
};
