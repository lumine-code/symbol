const { Point, Range } = require("lumine");
const trackSymbolCoordinates = require("../lib/track-symbol-coordinates");

describe("Symbol coordinate batches", () => {
  function clone(symbols) {
    return symbols.map(({ position, range }) => ({
      position: position.copy(),
      range: range.copy(),
    }));
  }

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
});
