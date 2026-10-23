const { Point, Range, TextBuffer } = require("lumine");
const trackSymbolCoordinates = require("../lib/track-symbol-coordinates");

describe("Symbol coordinate batches", () => {
  function prepare(symbols) {
    for (const _ of trackSymbolCoordinates.prepare(symbols)) {
      // The registry advances this generator cooperatively before publication.
    }
    return symbols;
  }

  function clone(symbols) {
    return symbols.map(({ position, range }) => ({
      position: position.copy(),
      range: range.copy(),
    }));
  }

  it("skips distant blocks without losing endpoints of enclosing ranges", () => {
    const symbols = Array.from({ length: 8192 }, (_, row) => ({
      position: new Point(row, 3),
      range: new Range([row, 0], [row, 8]),
    }));
    // Unordered endpoints must be included even in a distant position block.
    symbols[0].range = new Range([0, 0], [8191, 10]);
    symbols[2].range = new Range([8191, 1], [8191, 4]);
    const expected = clone(symbols);
    const changes = [
      {
        oldRange: new Range([8191, 2], [8191, 2]),
        newRange: new Range([8191, 2], [8191, 4]),
        oldText: "",
        newText: "🦉",
      },
    ];
    trackSymbolCoordinates(expected, changes);
    prepare(symbols);
    const position = symbols[8191].position;
    const range = symbols[8191].range;
    spyOn(Point.prototype, "compare").and.callThrough();
    trackSymbolCoordinates(symbols, changes);
    expect(Point.prototype.compare.calls.count()).toBeLessThan(2000);
    expect(symbols).toEqual(expected);
    expect(symbols[8191].position).toBe(position);
    expect(symbols[8191].range).toBe(range);
  });

  it("matches unindexed tracking through mixed edits and subsequent queries of shifted blocks", () => {
    let seed = 0x71ab239;
    const random = (limit) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const symbols = prepare(
      Array.from({ length: 1024 }, (_, row) => ({
        position: new Point(row, random(12)),
        range:
          row % 3
            ? new Range([row, random(6)], [row + random(20), 12])
            : new Range([row, 3], [row, 3]),
      })),
    );
    const expected = clone(symbols);
    for (let step = 0; step < 160; step++) {
      const changes = Array.from({ length: step % 4 === 0 ? 20 : 1 }, () => {
        const row = random(1040),
          column = random(12);
        const bulk = step % 4 === 0;
        return {
          oldRange: new Range([row, column], [row + (bulk ? 0 : random(6)), column + 3]),
          newRange: new Range([row, column], [row + (bulk ? 0 : random(4)), column + 2]),
          oldText: "old",
          newText: "🦉",
        };
      });
      for (const change of changes) trackSymbolCoordinates(expected, [change]);
      trackSymbolCoordinates(symbols, changes);
      expect(symbols).toEqual(expected);
    }
  });

  it("rejects unaffected symbols inside blocks crossed by long enclosing ranges", () => {
    const symbols = prepare(
      Array.from({ length: 8192 }, (_, row) => ({
        position: new Point(row, 3),
        range: new Range([row, 0], [row % 128 === 0 ? 8191 : row, 20]),
      })),
    );
    const expected = clone(symbols);
    const changes = [
      {
        oldRange: new Range([8190, 3], [8191, 3]),
        newRange: new Range([8190, 3], [8190, 3]),
        oldText: "\n",
        newText: "",
      },
    ];
    trackSymbolCoordinates(expected, changes);
    spyOn(Point.prototype, "compare").and.callThrough();
    trackSymbolCoordinates(symbols, changes);
    expect(Point.prototype.compare.calls.count()).toBeLessThan(3000);
    expect(symbols).toEqual(expected);
  });

  it("does not publish an incomplete index when preparation is cancelled", () => {
    const symbols = Array.from({ length: 512 }, (_, row) => ({
      position: new Point(row, 1),
      range: new Range([row, 0], [row, 8]),
    }));
    const expected = clone(symbols);
    const preparation = trackSymbolCoordinates.prepare(symbols);
    preparation.next();
    preparation.return();
    const changes = [
      {
        oldRange: new Range([400, 0], [400, 0]),
        newRange: new Range([400, 0], [401, 0]),
        oldText: "",
        newText: "\n",
      },
    ];
    trackSymbolCoordinates(expected, changes);
    trackSymbolCoordinates(symbols, changes);
    expect(symbols).toEqual(expected);
  });

  it("matches sequential tracking for bulk column edits, boundaries and empty ranges", () => {
    const symbols = Array.from({ length: 300 }, (_, row) => ({
      position: new Point(row, row % 8),
      range:
        row % 3 === 0
          ? new Range([row, row % 8], [row, row % 8])
          : new Range([row, 0], [row + 1, 10]),
    }));
    const changes = [];
    for (let row = 299; row >= 0; row--) {
      changes.push({
        oldRange: new Range([row, 0], [row, 0]),
        newRange: new Range([row, 0], [row, 2]),
        oldText: "",
        newText: "# ",
      });
      changes.push({
        oldRange: new Range([row, 1], [row, 4]),
        newRange: new Range([row, 1], [row, 2]),
        oldText: " xx",
        newText: "λ",
      });
    }
    const expected = clone(symbols);
    for (const change of changes) trackSymbolCoordinates(expected, [change]);
    spyOn(Point.prototype, "compare").and.callThrough();
    trackSymbolCoordinates(symbols, changes);
    expect(Point.prototype.compare.calls.count()).toBeLessThan(10000);
    expect(symbols).toEqual(expected);
  });

  it("retains sequential coordinates when any change inserts or deletes rows", () => {
    const symbols = [{ position: new Point(20, 3), range: new Range([20, 0], [22, 4]) }];
    const changes = Array.from({ length: 20 }, (_, index) => ({
      oldRange: new Range([0, 0], [0, 0]),
      newRange: new Range([0, 0], index % 2 ? [0, 2] : [1, 0]),
      oldText: "",
      newText: index % 2 ? "# " : "\n",
    }));
    const expected = clone(symbols);
    for (const change of changes) trackSymbolCoordinates(expected, [change]);
    trackSymbolCoordinates(symbols, changes);
    expect(symbols).toEqual(expected);
  });

  it("uses point affinity after an earlier edit collapses a structural range", () => {
    const symbols = [{ position: new Point(2, 1), range: new Range([2, 0], [2, 3]) }];
    const changes = [
      {
        oldRange: new Range([2, 0], [2, 3]),
        newRange: new Range([2, 0], [2, 0]),
        oldText: "abc",
        newText: "",
      },
      {
        oldRange: new Range([2, 0], [2, 0]),
        newRange: new Range([2, 0], [2, 2]),
        oldText: "",
        newText: "🦉",
      },
      ...Array.from({ length: 16 }, (_, row) => ({
        oldRange: new Range([row + 10, 0], [row + 10, 0]),
        newRange: new Range([row + 10, 0], [row + 10, 1]),
        oldText: "",
        newText: "#",
      })),
    ];
    trackSymbolCoordinates(symbols, changes);
    expect(symbols[0].position).toEqual(new Point(2, 2));
    expect(symbols[0].range).toEqual(new Range([2, 2], [2, 2]));
  });

  for (const direction of ["ascending", "descending"])
    it(`matches sequential tracking for ${direction} disjoint multiline edits and refreshed block bounds`, () => {
      const original = Array.from({ length: 32 }, (_, index) => {
        const row = 16 + index * 8;
        return {
          oldRange: new Range([row, 2], [row + (index % 3), 5]),
          newRange: new Range([row, 2], [row + (index % 4), 3]),
          oldText: "old",
          newText: "new",
        };
      });
      let shift = 0;
      const changes =
        direction === "descending"
          ? original.toReversed()
          : original.map((change) => {
              const current = {
                ...change,
                oldRange: new Range(
                  [change.oldRange.start.row + shift, 2],
                  [change.oldRange.end.row + shift, 5],
                ),
                newRange: new Range(
                  [change.newRange.start.row + shift, 2],
                  [change.newRange.end.row + shift, 3],
                ),
              };
              shift += change.newRange.end.row - change.oldRange.end.row;
              return current;
            });
      const symbols = Array.from({ length: 512 }, (_, row) => ({
        position: new Point(row, row % 7),
        range:
          row % 5 === 0
            ? new Range([row, 2], [row, 2])
            : new Range([row, row % 6], [row + (row % 11), 7]),
      }));
      for (const change of original) {
        for (const boundary of [change.oldRange.start, change.oldRange.end])
          symbols.push({
            position: boundary.copy(),
            range: new Range(boundary.copy(), boundary.copy()),
          });
        symbols.push({ position: change.oldRange.start.copy(), range: change.oldRange.copy() });
      }
      symbols[0].range = new Range([0, 0], [511, 10]);
      const expected = clone(symbols);
      const identities = symbols.map((symbol) => [symbol.position, symbol.range]);
      prepare(symbols);
      for (const change of changes) trackSymbolCoordinates(expected, [change]);
      trackSymbolCoordinates(symbols, changes);
      expect(symbols).toEqual(expected);
      for (let index = 0; index < symbols.length; index++) {
        expect(symbols[index].position).toBe(identities[index][0]);
        expect(symbols[index].range).toBe(identities[index][1]);
      }
      const followup = [
        {
          oldRange: new Range([500, 0], [500, 0]),
          newRange: new Range([500, 0], [501, 0]),
          oldText: "",
          newText: "\n",
        },
      ];
      trackSymbolCoordinates(expected, followup);
      trackSymbolCoordinates(symbols, followup);
      expect(symbols).toEqual(expected);
    });

  it("shifts a distant symbol suffix once for a large multiline batch", () => {
    const symbols = prepare(
      Array.from({ length: 512 }, (_, index) => ({
        position: new Point(10000 + index, 3),
        range: new Range([10000 + index, 0], [10000 + index, 8]),
      })),
    );
    const changes = Array.from({ length: 128 }, (_, index) => {
      const row = (128 - index) * 8;
      return {
        oldRange: new Range([row, 0], [row + 2, 3]),
        newRange: new Range([row, 0], [row, 0]),
        oldText: "x\ny\nz",
        newText: "",
      };
    });
    const expected = clone(symbols);
    for (const change of changes) trackSymbolCoordinates(expected, [change]);
    let writes = 0;
    for (const { position, range } of symbols)
      for (const point of [position, range.start, range.end]) {
        let row = point.row;
        Object.defineProperty(point, "row", {
          configurable: true,
          enumerable: true,
          get: () => row,
          set: (value) => {
            row = value;
            writes++;
          },
        });
      }
    trackSymbolCoordinates(symbols, changes);
    expect(symbols).toEqual(expected);
    expect(writes).toBeLessThanOrEqual(symbols.length * 3);
  });

  it("tracks real independent multiline edits and their undo/redo application batches", () => {
    const buffer = new TextBuffer({ text: "line text\n".repeat(4000) });
    const symbols = prepare(
      Array.from({ length: 4000 }, (_, row) => ({
        position: new Point(row, 5),
        range: new Range([row, 0], [row, 9]),
      })),
    );
    const expected = clone(symbols);
    let batches = 0;
    const subscription = buffer.onDidApplyChanges(({ changes }) => {
      batches++;
      for (const change of changes) trackSymbolCoordinates(expected, [change]);
      trackSymbolCoordinates(symbols, changes);
      expect(symbols).toEqual(expected);
    });
    try {
      buffer.setTextInIndependentRanges(
        Array.from({ length: 128 }, (_, index) => {
          const row = 10 + index * 25;
          return {
            range: [
              [row, 4],
              [row, 4],
            ],
            text: "first\n  second\n  third",
          };
        }),
      );
      buffer.undo();
      buffer.redo();
      expect(batches).toBe(3);
    } finally {
      subscription.dispose();
      buffer.destroy();
    }
  });
});
