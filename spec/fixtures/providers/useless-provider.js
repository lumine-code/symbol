const { Point } = require('lumine');

module.exports = {
  packageName: 'symbol-provider-useless',
  name: 'Useless',
  isExclusive: false,
  canProvideSymbols (meta) {
    return false;
  },
  getSymbols (meta) {
    return null;
  }
};
