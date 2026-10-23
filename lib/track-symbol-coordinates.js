// Bundle membership stays fixed while its coordinates follow edits. Index
// small blocks, including range endpoints: nested ranges need not follow the
// ordering of navigation positions. The weak key retains no discarded bundle.
const blocksBySymbols = new WeakMap();
const BLOCK_SIZE = 128;

function measureBlock(symbols, start, end) {
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (let i = start; i < end; i++) {
    const { position, range } = symbols[i];
    minRow = Math.min(minRow, position.row, range.start.row, range.end.row);
    maxRow = Math.max(maxRow, position.row, range.start.row, range.end.row);
  }
  return { start, end, minRow, maxRow };
}

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

function translateSymbol({ position, range }, oldRange, newRange) {
  // Structural ranges include text inserted at their boundaries. A
  // point-only provider's empty range follows its navigation point instead.
  const pointOnly = range.isEmpty();
  translatePoint(position, oldRange, newRange, true);
  translatePoint(range.start, oldRange, newRange, pointOnly);
  translatePoint(range.end, oldRange, newRange, true);
}

function orderedDisjointChanges(changes) {
  const active = changes.filter((change) => change.oldText !== change.newText);
  if (active.length < 16) return null;
  let ascending = true;
  let descending = true;
  for (let index = 0; index < active.length; index++) {
    const current = active[index];
    if (!current.oldRange.start.isEqual(current.newRange.start)) return null;
    if (!index) continue;
    const previous = active[index - 1];
    // Restrict this shortcut to separate rows. Touching/same-row edits need
    // sequential column composition and may change an empty range's affinity.
    ascending &&= previous.newRange.end.row < current.oldRange.start.row;
    descending &&= current.oldRange.end.row < previous.oldRange.start.row;
    if (!ascending && !descending) return null;
  }
  const ordered = ascending ? active : active.toReversed();
  let prefixRows = 0;
  return ordered.map(({ oldRange, newRange }) => {
    // Top-to-bottom applied edits already include prior row shifts. Bottom-
    // to-top edits leave each earlier edit in its original coordinates.
    const offset = ascending ? prefixRows : 0;
    const delta = newRange.end.row - oldRange.end.row;
    const change = {
      startRow: oldRange.start.row - offset,
      startColumn: oldRange.start.column,
      endRow: oldRange.end.row - offset,
      endColumn: oldRange.end.column,
      newEndRow: newRange.end.row - offset,
      newEndColumn: newRange.end.column,
      prefixRows,
      delta,
    };
    prefixRows += delta;
    return change;
  });
}

function translateOrderedPoint(point, changes, rightAffinity) {
  const { row, column } = point;
  let low = 0;
  let high = changes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const change = changes[middle];
    if (change.startRow < row || (change.startRow === row && change.startColumn <= column))
      low = middle + 1;
    else high = middle;
  }
  if (!low) return;
  const change = changes[low - 1];
  if (row === change.startRow && column === change.startColumn && !rightAffinity) {
    point.row += change.prefixRows;
  } else if (row < change.endRow || (row === change.endRow && column <= change.endColumn)) {
    point.row = (rightAffinity ? change.newEndRow : change.startRow) + change.prefixRows;
    point.column = rightAffinity ? change.newEndColumn : change.startColumn;
  } else {
    if (row === change.endRow) point.column += change.newEndColumn - change.endColumn;
    point.row += change.prefixRows + change.delta;
  }
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
  const blocks = blocksBySymbols.get(symbols);
  const ordered = changes.length >= 16 && orderedDisjointChanges(changes);
  if (ordered) {
    for (const { position, range } of symbols) {
      const pointOnly = range.isEmpty();
      translateOrderedPoint(position, ordered, true);
      translateOrderedPoint(range.start, ordered, pointOnly);
      translateOrderedPoint(range.end, ordered, true);
    }
    // Membership and Point/Range identities are retained. Refresh each
    // prepared block once, rather than shifting its endpoints per edit.
    for (const block of blocks ?? []) {
      const measured = measureBlock(symbols, block.start, block.end);
      block.minRow = measured.minRow;
      block.maxRow = measured.maxRow;
    }
    return;
  }
  for (const { oldRange, newRange, oldText, newText } of changes) {
    if (oldText === newText) continue;
    if (!blocks) {
      for (const symbol of symbols) translateSymbol(symbol, oldRange, newRange);
      continue;
    }
    const rowDelta = newRange.end.row - oldRange.end.row;
    const rowsCanChange = rowDelta !== 0 || oldRange.start.row !== oldRange.end.row;
    for (const block of blocks) {
      if (block.maxRow < oldRange.start.row) continue;
      if (rowDelta === 0 && block.minRow > oldRange.end.row) continue;
      if (block.minRow > oldRange.end.row) {
        // Every endpoint is strictly after the replacement. Columns and
        // affinity are unchanged, and the entire block shifts by one delta.
        for (let i = block.start; i < block.end; i++) {
          const { position, range } = symbols[i];
          position.row += rowDelta;
          range.start.row += rowDelta;
          range.end.row += rowDelta;
        }
        block.minRow += rowDelta;
        block.maxRow += rowDelta;
        continue;
      }
      let minRow = Infinity;
      let maxRow = -Infinity;
      for (let i = block.start; i < block.end; i++) {
        const symbol = symbols[i];
        const { position, range } = symbol;
        // A long enclosing range can make an otherwise distant block overlap.
        // Most of that block's symbols can still be rejected using row numbers.
        const before =
          position.row < oldRange.start.row &&
          range.start.row < oldRange.start.row &&
          range.end.row < oldRange.start.row;
        const after =
          rowDelta === 0 &&
          position.row > oldRange.end.row &&
          range.start.row > oldRange.end.row &&
          range.end.row > oldRange.end.row;
        if (!before && !after) translateSymbol(symbol, oldRange, newRange);
        if (rowsCanChange) {
          minRow = Math.min(minRow, position.row, range.start.row, range.end.row);
          maxRow = Math.max(maxRow, position.row, range.start.row, range.end.row);
        }
      }
      if (rowsCanChange) {
        block.minRow = minRow;
        block.maxRow = maxRow;
      }
    }
  }
};

// Prepare cooperatively before publishing a bundle, never on its first edit.
// Cancellation leaves no partially prepared index visible to tracking.
module.exports.prepare = function* prepare(symbols) {
  const blocks = [];
  for (let start = 0; start < symbols.length; start += BLOCK_SIZE) {
    blocks.push(measureBlock(symbols, start, Math.min(start + BLOCK_SIZE, symbols.length)));
    yield;
  }
  blocksBySymbols.set(symbols, blocks);
  return symbols;
};
