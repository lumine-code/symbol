const Dummy = require("./dummy-provider");
module.exports = {
  ...Dummy,
  packageName: "symbol-provider-quicksort",
  name: "Quicksort",
  getDocumentSymbols(editor) {
    return Dummy.getDocumentSymbols(editor).map((symbol, index) => ({
      ...symbol,
      name: index === 0 ? "quicksort" : symbol.name,
    }));
  },
};
