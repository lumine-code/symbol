const { Point } = require('lumine');

module.exports = {
  packageName: 'symbol-provider-empty',
  name: 'Empty',
  isExclusive: false,
  canProvideSymbols (meta) {
    return true;
  },
  getSymbols (meta) {
    return [];
  }
};
