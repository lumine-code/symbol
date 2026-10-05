module.exports = {
  packageName: "symbol-provider-late",
  name: "Late",
  canProvideDocumentSymbols: () => 1,
  getDocumentSymbols() {
    this.answered = new Promise((resolve) =>
      setTimeout(() => resolve([{ name: "late", position: [0, 0] }]), 800),
    );
    return this.answered;
  },
};
