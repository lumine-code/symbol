module.exports = {
  packageName: "symbol-provider-hanging",
  name: "Hanging",
  getDocumentSymbolSources: () => new Promise(() => {}),
  getDocumentSymbols: () => [],
};
