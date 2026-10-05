module.exports = {
  packageName: "symbol-provider-very-slow",
  name: "Very Slow",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 1, state: "ready" }]; },
  getDocumentSymbols: () =>
    new Promise((resolve) => setTimeout(() => resolve([{ name: "late", position: [0, 0] }]), 3000)),
};
