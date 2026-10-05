const Dummy = require("./dummy-provider");
module.exports = {
  ...Dummy,
  packageName: "symbol-provider-preferred",
  name: "Preferred",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 0.9, state: "ready" }]; },
};
