const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Symbol workspace queries during project restoration", () => {
  let directory, roots, main, lease, finish, requested, request;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "symbol-project-owner-")));
    roots = [path.join(directory, "a"), path.join(directory, "b")];
    roots.forEach((root) => fs.mkdirSync(root));
    lumine.project.setPaths([roots[0]]);
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
    requested = new Promise((resolve) => {
      lease = lumine.packages.serviceHub.provide("symbol.workspace-provider", "1.0.0", {
        packageName: "symbol-transition-provider",
        name: "Transition provider",
        searchWorkspaceSymbols(_query, options) {
          request = options;
          resolve();
          return new Promise((done) => (finish = done));
        },
      });
    });
  });

  afterEach(async () => {
    finish?.([]);
    lease?.dispose();
    await lumine.packages.deactivatePackage("symbol");
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    const real = fs.realpathSync(directory);
    if (
      path.dirname(real) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(real).startsWith("symbol-project-owner-")
    )
      throw new Error("Unsafe symbol project fixture cleanup");
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const symbolAt = (root) => ({
    name: "owned symbol",
    path: path.join(root, "file.js"),
    position: [0, 0],
  });

  it("preserves a query while its project remains current", async () => {
    const published = jasmine.createSpy("symbols published");
    const pending = main.provideSymbolRegistry().searchWorkspace("owned", { onSymbols: published });
    await requested;
    expect(request.paths).toEqual([roots[0]]);
    finish([symbolAt(roots[0])]);
    const symbols = await pending;
    expect(symbols[0].name).toBe("owned symbol");
    expect(published).toHaveBeenCalled();
  });

  it("retires the outgoing query before incoming storage precedes its restored roots", async () => {
    const published = jasmine.createSpy("obsolete symbols published");
    const pending = main.provideSymbolRegistry().searchWorkspace("owned", { onSymbols: published });
    await requested;
    let reached, resume;
    const rebound = new Promise((resolve) => (reached = resolve));
    const held = new Promise((resolve) => (resume = resolve));
    const switchProject = lumine.packages.storage.switchProject.bind(lumine.packages.storage);
    spyOn(lumine.packages.storage, "switchProject").and.callFake(async (paths) => {
      await switchProject(paths);
      reached();
      await held;
    });
    const transition = lumine.project.setState([roots[1]]);
    try {
      await rebound;
      expect(lumine.project.getPaths()).toEqual([roots[0]]);
      expect(request.signal.aborted).toBe(true);
      finish([symbolAt(roots[0])]);
      expect(await pending).toBeNull();
      expect(published).not.toHaveBeenCalled();
    } finally {
      resume();
      await transition;
    }
  });
});
