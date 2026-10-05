module.exports = {
  packageName: "symbol-provider-late",
  name: "Late",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 1, state: "ready" }]; },
  getDocumentSymbols() {
    this.answered = new Promise((resolve) =>
      setTimeout(() => resolve([{ name: "late", position: [0, 0] }]), 800),
    );
    return this.answered;
  },
};
