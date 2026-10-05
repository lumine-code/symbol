const { Point } = require("lumine");
module.exports = {
  packageName: "symbol-provider-tagged",
  name: "Tagged",
  mockResultCount: 1,
  mockFileName: "tagged.js",
  reset() {
    this.mockResultCount = 1;
    this.mockFileName = "tagged.js";
  },
  searchWorkspaceSymbols(_query, { paths }) {
    return Array.from({ length: this.mockResultCount }, (_, index) => ({
      directory: paths.at(-1),
      file: this.mockFileName,
      position: new Point(2 + index, 10),
      name: "callMeMaybe",
    }));
  },
  canProvideDefinitions: () => true,
  getDefinitions() {
    return Array.from({ length: this.mockResultCount }, (_, index) => ({
      directory: lumine.project.getPaths().at(-1),
      file: this.mockFileName,
      position: new Point(2 + index, 0),
      name: "callMeMaybe",
    }));
  },
};
