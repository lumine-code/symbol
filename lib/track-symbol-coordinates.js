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
  // Column-only edits cannot move a point on another row. Bulk commenting
  // otherwise revisits every symbol for every line in the file. Keep each
  // row's edits in application order, including repeated edits on that row.
  if (
    changes.length >= 16 &&
    changes.every(
      ({ oldRange, newRange }) =>
        oldRange.start.isEqual(newRange.start) &&
        oldRange.start.row === oldRange.end.row &&
        oldRange.start.row === newRange.end.row,
    )
  ) {
    const byRow = new Map();
    for (const change of changes) {
      if (change.oldText === change.newText) continue;
      let row = byRow.get(change.oldRange.start.row);
      if (!row) byRow.set(change.oldRange.start.row, (row = []));
      row.push(change);
    }
    const translate = (point, rightAffinity) => {
      for (const { oldRange, newRange } of byRow.get(point.row) ?? [])
        translatePoint(point, oldRange, newRange, rightAffinity);
    };
    for (const { position, range } of symbols) {
      translate(position, true);
      if (range.start.row === range.end.row) {
        for (const { oldRange, newRange } of byRow.get(range.start.row) ?? []) {
          const pointOnly = range.isEmpty();
          translatePoint(range.start, oldRange, newRange, pointOnly);
          translatePoint(range.end, oldRange, newRange, true);
        }
      } else {
        translate(range.start, false);
        translate(range.end, true);
      }
    }
    return;
  }
  for (const { oldRange, newRange, oldText, newText } of changes) {
    if (oldText === newText) continue;
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
