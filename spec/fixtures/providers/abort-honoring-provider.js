module.exports = {
  packageName: "symbol-provider-abort-honoring",
  name: "Abort Honoring",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 1, state: "ready" }]; },
  getDocumentSymbols(_editor, { signal }) {
    this.answered = new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return this.answered;
  },
};
