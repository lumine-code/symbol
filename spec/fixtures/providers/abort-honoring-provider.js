module.exports = {
  packageName: "symbol-provider-abort-honoring",
  name: "Abort Honoring",
  canProvideDocumentSymbols: () => 1,
  getDocumentSymbols(_editor, { signal }) {
    this.answered = new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return this.answered;
  },
};
