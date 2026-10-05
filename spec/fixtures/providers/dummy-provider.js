const { Point } = require("lumine");
const ICONS = ["package", "key", "gear", "tag", null];
const documentSymbols = (editor) =>
  Array.from({ length: Math.ceil(editor.getLineCount() / 3) }, (_, index) => ({
    position: new Point(index * 3, 0),
    name: `Symbol on Row ${index * 3 + 1}`,
    icon: ICONS[index % (ICONS.length + 1)],
  }));
module.exports = {
  packageName: "symbol-provider-dummy",
  name: "Dummy",
  getDocumentSymbolSources() { return [{ id: this.packageName, name: this.name, shortLabel: "SP", score: 1, state: "ready" }]; },
  getDocumentSymbols: documentSymbols,
  searchWorkspaceSymbols(_query, { paths }) {
    return [0, 3, 6, 9, 12].map((row, index) => ({
      position: new Point(row, 0),
      name: `Symbol on Row ${row + 1}`,
      directory: paths.at(-1),
      file: "other-file.js",
      icon: ICONS[index % (ICONS.length + 1)],
    }));
  },
};
