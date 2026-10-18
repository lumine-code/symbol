const { Point } = require("lumine");
const DocumentWork = require("../lib/document-work");

describe("document snapshot work", () => {
  it("sorts unordered results stably across tasks", async () => {
    const symbols = Array.from({ length: 10000 }, (_, index) => ({
      name: String(index),
      position: new Point(999 - (index % 1000), 0),
    }));
    let yields = 0;
    const result = await DocumentWork.run(DocumentWork.sort(symbols), {
      yieldTask: async () => yields++,
    });
    expect(yields).toBeGreaterThan(1);
    for (let index = 1; index < result.length; index++) {
      expect(result[index - 1].position.compare(result[index].position)).toBeLessThanOrEqual(0);
      if (result[index - 1].position.isEqual(result[index].position)) {
        expect(Number(result[index - 1].name)).toBeLessThan(Number(result[index].name));
      }
    }
    expect(new Set(result).size).toBe(symbols.length);
  });

  it("closes cancelled work without exposing a partial result", async () => {
    const controller = new AbortController();
    let visited = 0;
    let closed = false;
    function* work() {
      try {
        while (visited < 10000) {
          visited++;
          yield;
        }
        return "complete";
      } finally {
        closed = true;
      }
    }
    const result = await DocumentWork.run(work(), {
      signal: controller.signal,
      yieldTask: async () => controller.abort(),
    });
    expect(result).toBeNull();
    expect(visited).toBeLessThan(10000);
    expect(closed).toBe(true);
  });
});
