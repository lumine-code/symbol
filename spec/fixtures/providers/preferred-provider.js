const Dummy = require("./dummy-provider");
module.exports = {
  ...Dummy,
  packageName: "symbol-provider-preferred",
  name: "Preferred",
  canProvideDocumentSymbols: () => 0.9,
};
