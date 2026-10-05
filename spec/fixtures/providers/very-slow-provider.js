module.exports = {
  packageName: "symbol-provider-very-slow",
  name: "Very Slow",
  canProvideDocumentSymbols: () => 1,
  getDocumentSymbols: () =>
    new Promise((resolve) => setTimeout(() => resolve([{ name: "late", position: [0, 0] }]), 3000)),
};
