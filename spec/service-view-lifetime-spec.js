const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Symbol service and picker lifetimes", () => {
  let main, a, b, targetEditor, directory, file, leases;
  const symbols = (name) => [{ name, position: [2, 0] }];
  function provider(getDocumentSymbols = (editor) => symbols(editor === a ? "A" : "B")) {
    return {
      name: "Owned backend",
      packageName: "owned-symbol-source",
      getDocumentSymbolSources: () => [
        {
          id: "owned-symbol-source",
          name: "Owned backend",
          shortLabel: "OS",
          score: 1,
          state: "ready",
          execution: "local",
        },
      ],
      getDocumentSymbols,
      canProvideDefinitions: () => 1,
      getDefinitions: () => symbols("Definition"),
      searchWorkspaceSymbols: () => [{ name: "Workspace", position: [2, 0], path: file }],
    };
  }
  function provide(role, payload) {
    const lease = lumine.packages.serviceHub.provide(`symbol.${role}-provider`, "1.0.0", payload);
    leases.push(lease);
    return lease;
  }
  function select(editor) {
    lumine.workspace.paneForItem(editor).activateItem(editor);
    editor.element.focus();
  }
  async function choices(view, name) {
    await conditionPromise(
      () =>
        view.selectList.getItems().some((symbol) => symbol.name === name) &&
        !view.selectList.isLoading(),
      `current symbol choices ${name}`,
    );
    await new Promise((resolve) => lumine.views.updateDocument(resolve));
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    leases = [];
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "symbol-owner-")));
    file = path.join(directory, "owned.txt");
    fs.writeFileSync(file, "one\ntwo\nthree\n");
    lumine.project.setPaths([directory]);
    lumine.config.set("symbol.showStatusBarItem", false);
    lumine.config.set("symbol.quickJumpToFileSymbol", false);
    await lumine.packages.deactivatePackage("symbol");
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
    a = await lumine.workspace.open();
    a.setText("A-one\nA-two\nA-three\n");
    b = await lumine.workspace.open();
    b.setText("B-one\nB-two\nB-three\n");
  });
  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("symbol");
    a?.destroy();
    b?.destroy();
    targetEditor?.destroy();
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw new Error("Unsafe symbol fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  for (const role of ["document", "definition", "workspace"]) {
    it(`keeps a shared ${role} provider after one exact Hub edge withdraws`, async () => {
      const payload = provider();
      const first = provide(role, payload);
      provide(role, payload);
      if (role === "document") main.service.setDocumentSource(a, payload.packageName);
      first.dispose();
      const result =
        role === "document"
          ? await main.service.getFileSymbols(a)
          : role === "definition"
            ? await main.service.findDefinitions(a)
            : await main.service.searchWorkspace();
      expect(result?.length).toBe(1);
    });
  }

  it("does not let a retired file snapshot cancel the newer file picker", async () => {
    let finish;
    const payload = provider((editor) =>
      editor === a ? new Promise((resolve) => (finish = resolve)) : symbols("B"),
    );
    provide("document", payload);
    main.service.setDocumentSource(a, payload.packageName);
    main.service.setDocumentSource(b, payload.packageName);
    select(a);
    const view = main.createFileView();
    const opening = view.toggle();
    await conditionPromise(() => finish, "pending original file symbol request");
    await view.cancel();
    select(b);
    await view.toggle();
    await choices(view, "B");
    a.insertText("changed");
    // The actual registry invalidates A and returns null without stopping B.
    await opening;
    finish(symbols("A"));
    await Promise.resolve();
    await new Promise((resolve) => lumine.views.updateDocument(resolve));
    expect(view.isVisible()).toBe(true);
    expect(view.selectList.getItems().map((symbol) => symbol.name)).toEqual(["B"]);
  });

  it("restores quick-jump state only in the picker source editor on cancellation", async () => {
    lumine.config.set("symbol.quickJumpToFileSymbol", true);
    const payload = provider();
    provide("document", payload);
    main.service.setDocumentSource(a, payload.packageName);
    a.setCursorBufferPosition([0, 1]);
    b.setCursorBufferPosition([0, 2]);
    select(a);
    const view = main.createFileView();
    await view.toggle();
    await choices(view, "A");
    expect(a.getCursorBufferPosition().toArray()).toEqual([2, 0]);
    select(b);
    await view.cancel();
    expect(b.getCursorBufferPosition().toArray()).toEqual([0, 2]);
    expect(a.getCursorBufferPosition().toArray()).toEqual([0, 1]);
  });

  it("opens a confirmed file symbol in its captured source after another editor activates", async () => {
    const payload = provider();
    provide("document", payload);
    main.service.setDocumentSource(a, payload.packageName);
    a.setCursorBufferPosition([0, 1]);
    b.setCursorBufferPosition([0, 2]);
    select(a);
    const view = main.createFileView();
    await view.toggle();
    await choices(view, "A");
    select(b);
    await view.selectList.confirmSelection();
    expect(a.getCursorBufferPosition().toArray()).toEqual([2, 0]);
    expect(b.getCursorBufferPosition().toArray()).toEqual([0, 2]);
  });

  it("keeps a single real source selector per shared status-bar payload", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    // Core's wrapper is a distinct payload from this raw bar, so preserve its
    // already live selector and measure only the repeated exact bar payload.
    const baseline = bar.element.querySelectorAll(".symbol-source-status").length;
    const first = lumine.packages.serviceHub.provide("status-bar", "1.0.0", bar);
    const second = lumine.packages.serviceHub.provide("status-bar", "1.0.0", bar);
    leases.push(first, second);
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline + 1);
    first.dispose();
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline + 1);
  });

  it("keeps an initializing status selector alive during reentrant duplicate withdrawal", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    const baseline = bar.element.querySelectorAll(".symbol-source-status").length;
    let reentered = false;
    const api = {
      addLeftTile: (options) => {
        const tile = bar.addLeftTile(options);
        if (!reentered) {
          reentered = true;
          main.consumeStatusBar(api).dispose();
        }
        return tile;
      },
      addRightTile: (options) => bar.addRightTile(options),
    };
    const lease = main.consumeStatusBar(api);
    expect(reentered).toBe(true);
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline + 1);
    lease.dispose();
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline);
  });

  it("releases a real tile returned after its exact status provider edge retires", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    let armed = false,
      lease;
    const api = {
      addLeftTile: (options) => {
        const tile = bar.addLeftTile(options);
        if (armed) {
          armed = false;
          lease.dispose();
        }
        return tile;
      },
      addRightTile: (options) => bar.addRightTile(options),
    };
    lease = lumine.packages.serviceHub.provide("status-bar", "1.0.0", api);
    leases.push(lease);
    const view = [...main.sourceStatusViews].find((view) => view.statusBar === api);
    lumine.config.set("symbol.showStatusBarItem", false);
    armed = true;
    lumine.config.set("symbol.showStatusBarItem", true);
    expect(view.destroyed).toBe(true);
    expect(
      [...bar.getLeftTiles(), ...bar.getRightTiles()].some(
        (tile) => tile.getItem() === view.element,
      ),
    ).toBe(false);
  });

  it("keeps real status tile placement current after allocation changes its side", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    let armed = false;
    const api = {
      addLeftTile: (options) => {
        const tile = bar.addLeftTile(options);
        if (armed) {
          armed = false;
          lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", true);
        }
        return tile;
      },
      addRightTile: (options) => bar.addRightTile(options),
    };
    const lease = lumine.packages.serviceHub.provide("status-bar", "1.0.0", api);
    leases.push(lease);
    const view = [...main.sourceStatusViews].find((view) => view.statusBar === api);
    lumine.config.set("symbol.showStatusBarItem", false);
    armed = true;
    lumine.config.set("symbol.showStatusBarItem", true);
    expect(bar.getLeftTiles().some((tile) => tile.getItem() === view.element)).toBe(false);
    expect(bar.getRightTiles().some((tile) => tile.getItem() === view.element)).toBe(true);
    lease.dispose();
    expect(
      [...bar.getLeftTiles(), ...bar.getRightTiles()].some(
        (tile) => tile.getItem() === view.element,
      ),
    ).toBe(false);
  });

  it("does not move the real target editor after a retired revealCell handoff", async () => {
    let entered, finish;
    const arrived = new Promise((resolve) => (entered = resolve));
    const gate = new Promise((resolve) => (finish = resolve));
    targetEditor = await lumine.workspace.open(file);
    // Use the supported optional item boundary with a real Core pane/editor.
    // This control does not claim to execute a notebook backend.
    targetEditor.revealCell = async () => {
      entered();
      await gate;
    };
    const payload = provider();
    payload.getDefinitions = () => [
      { name: "Cell definition", position: [2, 0], path: file, cell: 1 },
    ];
    provide("definition", payload);
    select(a);
    const view = main.createGoToView();
    const going = view.populate();
    await arrived;
    await lumine.packages.deactivatePackage("symbol");
    targetEditor.setCursorBufferPosition([0, 1]);
    finish();
    await going;
    expect(targetEditor.getCursorBufferPosition().toArray()).toEqual([0, 1]);
    expect(view.stack.length).toBe(0);
  });
});
