describe("Workspace symbol matching", () => {
  let main;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("symbol");
  });
  it("reuses prepared names while attaching highlights to each fresh provider object", () => {
    // Reacquire this generation's constructor after activation.
    const ProjectView = require("../lib/project-view");
    const view = Object.create(ProjectView.prototype);
    const prepare = spyOn(lumine.tools.fuzzyMatcher, "setCandidates").and.callThrough();
    const first = [{ name: "alpha" }, { name: "beta" }];
    expect(view.filterProjectSymbols(first, "al")).toEqual([first[0]]);
    const second = [{ name: "alpha" }, { name: "beta" }];
    expect(view.filterProjectSymbols(second, "alp")).toEqual([second[0]]);
    expect(view.getSourceMatchIndices(second[0])).toEqual([0, 1, 2]);
    expect(view.getSourceMatchIndices(first[0])).toBeUndefined();
    expect(prepare.calls.count()).toBe(1);
    second[0].name = "gamma";
    expect(view.filterProjectSymbols(second, "alpha")).toEqual([]);
    expect(prepare.calls.count()).toBe(1);
    expect(main).toBeDefined();
  });
  it("traces only requested visible symbols and refreshes traces on query changes", () => {
    const ProjectView = require("../lib/project-view");
    const view = Object.create(ProjectView.prototype);
    const symbols = Array.from({ length: 1000 }, (_, i) => ({ name: `alpha${i}` }));
    expect(view.filterProjectSymbols(symbols, "al").length).toBe(1000);
    const trace = spyOn(view.sourceMatcher, "getMatchIndexes").and.callThrough();
    expect(view.sourceMatchIndices.get(symbols[0])).toBeUndefined();
    expect(view.getSourceMatchIndices(symbols[0])).toEqual([0, 1]);
    expect(view.getSourceMatchIndices(symbols[0])).toEqual([0, 1]);
    expect(trace.calls.count()).toBe(1);
    view.filterProjectSymbols(symbols, "alp");
    expect(trace.calls.count()).toBe(1);
    expect(view.getSourceMatchIndices(symbols[0])).toEqual([0, 1, 2]);
    expect(trace.calls.count()).toBe(2);
  });
});
