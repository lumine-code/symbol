function translatePoint(point, oldRange, newRange, rightAffinity) {
  const startComparison = point.compare(oldRange.start);
  if (startComparison < 0 || (startComparison === 0 && !rightAffinity)) return;

  if (point.compare(oldRange.end) <= 0) {
    const target = rightAffinity ? newRange.end : newRange.start;
    point.row = target.row;
    point.column = target.column;
    return;
  }

  if (point.row === oldRange.end.row) {
    point.column += newRange.end.column - oldRange.end.column;
  }
  point.row += newRange.end.row - oldRange.end.row;
}

module.exports = function trackSymbolCoordinates(symbols, changes) {
  for (const { oldRange, newRange } of changes) {
    for (const { position, range } of symbols) {
      // Structural ranges include text inserted at their boundaries. A
      // point-only provider's empty range follows its navigation point instead.
      const pointOnly = range.isEmpty();
      translatePoint(position, oldRange, newRange, true);
      translatePoint(range.start, oldRange, newRange, pointOnly);
      translatePoint(range.end, oldRange, newRange, true);
    }
  }
};
