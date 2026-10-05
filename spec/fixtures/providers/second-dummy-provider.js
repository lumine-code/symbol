const Dummy = require("./dummy-provider");
module.exports = {
  ...Dummy,
  packageName: "symbol-provider-dummy-second",
  name: "Second Dummy",
  getDocumentSymbols(editor) {
    return Dummy.getDocumentSymbols(editor).map((symbol) => ({
      ...symbol,
      name: "(Second) " + symbol.name,
    }));
  },
  searchWorkspaceSymbols(query, options) {
    return Dummy.searchWorkspaceSymbols(query, options).map((symbol) => ({
      ...symbol,
      name: "(Second) " + symbol.name,
    }));
  },
};
