const windowService = require("./helpers/window-service");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Symbol service and picker lifetimes", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

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

  it("restores the last committed navigation after repeated choices and a later preview", async () => {
    lumine.config.set("symbol.quickJumpToFileSymbol", true);
    const payload = provider(() => [
      { name: "First", position: [1, 0] },
      { name: "Second", position: [2, 0] },
    ]);
    provide("document", payload);
    main.service.setDocumentSource(a, payload.packageName);
    b.setCursorBufferPosition([0, 2]);
    select(a);
    const view = main.createFileView();
    await view.toggle();
    await choices(view, "First");
    await view.selectList.runAction("select-list:toggle-keep-open");
    for (const index of [0, 1]) {
      await view.selectList.selectIndex(index);
      await view.selectList.confirmSelection();
      expect(view.isVisible()).toBe(true);
      expect(a.getCursorBufferPosition().toArray()).toEqual([index + 1, 0]);
    }
    await view.selectList.selectIndex(0);
    expect(a.getCursorBufferPosition().toArray()).toEqual([1, 0]);
    await view.cancel();
    expect(a.getCursorBufferPosition().toArray()).toEqual([2, 0]);
    expect(b.getCursorBufferPosition().toArray()).toEqual([0, 2]);
  });

  for (const back of ["breadcrumb", "shift-escape"]) {
    it(`restores committed quick-jump navigation after a later preview and ${back} back`, async () => {
      lumine.config.set("symbol.quickJumpToFileSymbol", true);
      const payload = provider(() => [
        { name: "Committed", position: [1, 0] },
        { name: "Preview", position: [2, 0] },
      ]);
      provide("document", payload);
      main.service.setDocumentSource(a, payload.packageName);
      select(a);
      const parent = lumine.workspace.addInputDialog({}, { crumb: "Parent" });
      try {
        await parent.show();
        const view = main.createFileView();
        const attach = view.attach.bind(view);
        spyOn(view, "attach").and.callFake((options) => attach({ ...options, crumb: "Symbols" }));
        await view.toggle("", a);
        await choices(view, "Committed");
        await view.selectList.runAction("select-list:toggle-keep-open");
        await view.selectList.selectIndex(0);
        await view.selectList.confirmSelection();
        await view.selectList.selectIndex(1);
        expect(a.getCursorBufferPosition().toArray()).toEqual([2, 0]);

        if (back === "breadcrumb") {
          expect(lumine.workspace.popModal()).toBe(true);
        } else {
          const target = view.selectList.getQueryEditor().getElement();
          expect(
            lumine.keymaps.findKeyBindings({ keystrokes: "shift-escape", target })[0].command,
          ).toBe("modal:go-back");
          await lumine.commands.dispatch(target, "modal:go-back");
        }

        expect(parent.isVisible()).toBe(true);
        expect(view.isVisible()).toBe(false);
        expect(a.getCursorBufferPosition().toArray()).toEqual([1, 0]);
        expect(view.initialState).toBeNull();
        view.selectListHost.cancel();
        expect(a.getCursorBufferPosition().toArray()).toEqual([1, 0]);
      } finally {
        await parent.destroy();
      }
    });
  }

  it("clears terminal preview state before an immediate reopening", async () => {
    lumine.config.set("symbol.quickJumpToFileSymbol", true);
    const payload = provider(() => [
      { name: "First", position: [1, 0] },
      { name: "Second", position: [2, 0] },
    ]);
    provide("document", payload);
    main.service.setDocumentSource(a, payload.packageName);
    a.setCursorBufferPosition([0, 1]);
    select(a);
    const view = main.createFileView();
    await view.toggle();
    await choices(view, "First");
    await view.selectList.selectIndex(1);

    view.selectListHost.cancel();
    expect(a.getCursorBufferPosition().toArray()).toEqual([0, 1]);
    expect(view.initialState).toBeNull();
    expect(view.selectList.getItems()).toEqual([]);
    const reopening = view.toggle("", a);
    await reopening;
    await choices(view, "First");

    expect(view.isVisible()).toBe(true);
    expect(view.selectList.getItems().map(({ name }) => name)).toEqual(["First", "Second"]);
  });

  it("keeps a single real source selector per shared status-bar payload", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    // The scoped v2 service and manual edges share this exact bar identity.
    const baseline = bar.element.querySelectorAll(".symbol-source-status").length;
    const first = lumine.packages.serviceHub.provide("status-bar", "2.0.0", windowService(bar));
    const second = lumine.packages.serviceHub.provide("status-bar", "2.0.0", windowService(bar));
    leases.push(first, second);
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline);
    first.dispose();
    expect(bar.element.querySelectorAll(".symbol-source-status").length).toBe(baseline);
  });

  it("keeps an empty window's source selector cold until its first editor appears", async () => {
    a.destroy();
    b.destroy();
    lumine.config.set("symbol.showStatusBarItem", true);
    const bar = (await lumine.packages.activatePackage("status-bar")).mainModule.statusBar;
    const api = {
      addLeftTile: jasmine
        .createSpy("addLeftTile")
        .and.callFake((options) => bar.addLeftTile(options)),
      addRightTile: jasmine
        .createSpy("addRightTile")
        .and.callFake((options) => bar.addRightTile(options)),
    };
    leases.push(main.consumeStatusBar(windowService(api)));
    expect([...main.sourceStatusViews].find((view) => view.statusBar === api)).toBeUndefined();
    expect(api.addLeftTile).not.toHaveBeenCalled();
    expect(api.addRightTile).not.toHaveBeenCalled();
    a = await lumine.workspace.open();
    const view = [...main.sourceStatusViews].find((view) => view.statusBar === api);
    expect(view).toBeDefined();
    expect(view.editor).toBe(a);
    expect(api.addLeftTile.calls.count() + api.addRightTile.calls.count()).toBe(1);
  });

  it("does not wake a cold source selector after its last service edge withdraws", async () => {
    a.destroy();
    b.destroy();
    lumine.config.set("symbol.showStatusBarItem", true);
    const api = {
      addLeftTile: jasmine.createSpy("addLeftTile"),
      addRightTile: jasmine.createSpy("addRightTile"),
    };
    const lease = main.consumeStatusBar(windowService(api));
    lease.dispose();
    a = await lumine.workspace.open();
    expect([...main.sourceStatusViews].find((view) => view.statusBar === api)).toBeUndefined();
    expect(api.addLeftTile).not.toHaveBeenCalled();
    expect(api.addRightTile).not.toHaveBeenCalled();
  });

  it("allocates one source tile and retains it while its placement stays current", async () => {
    lumine.config.set("symbol.showStatusBarItem", true);
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    const api = {
      addLeftTile: jasmine
        .createSpy("addLeftTile")
        .and.callFake((options) => bar.addLeftTile(options)),
      addRightTile: jasmine
        .createSpy("addRightTile")
        .and.callFake((options) => bar.addRightTile(options)),
    };
    const lease = main.consumeStatusBar(windowService(api));
    leases.push(lease);
    const view = [...main.sourceStatusViews].find((view) => view.statusBar === api);
    const initial = view.tile;
    const destroy = spyOn(initial, "destroy").and.callThrough();
    view.attach();
    view.attach();
    expect(api.addLeftTile).toHaveBeenCalledTimes(1);
    expect(api.addRightTile).not.toHaveBeenCalled();
    expect(view.tile).toBe(initial);
    expect(destroy).not.toHaveBeenCalled();

    lumine.config.set("symbol.showStatusBarItem", false);
    view.attach();
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", true);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(api.addLeftTile).toHaveBeenCalledTimes(1);
    expect(api.addRightTile).not.toHaveBeenCalled();
    lumine.config.set("symbol.showStatusBarItem", true);
    expect(api.addRightTile).toHaveBeenCalledTimes(1);
    expect(bar.getRightTiles().some((tile) => tile.getItem() === view.element)).toBe(true);
  });

  it("keeps a tile allocated during a reentrant hide and show at the same placement", async () => {
    lumine.config.set("symbol.showStatusBarItem", false);
    lumine.config.set("grammar-selector.showOnRightSideOfStatusBar", false);
    const statusMain = (await lumine.packages.activatePackage("status-bar")).mainModule;
    const bar = statusMain.statusBar;
    let armed = false;
    const api = {
      addLeftTile: jasmine.createSpy("addLeftTile").and.callFake((options) => {
        const tile = bar.addLeftTile(options);
        if (armed) {
          armed = false;
          lumine.config.set("symbol.showStatusBarItem", false);
          lumine.config.set("symbol.showStatusBarItem", true);
        }
        return tile;
      }),
      addRightTile: (options) => bar.addRightTile(options),
    };
    const lease = main.consumeStatusBar(windowService(api));
    leases.push(lease);
    expect([...main.sourceStatusViews].find((view) => view.statusBar === api)).toBeUndefined();
    armed = true;
    lumine.config.set("symbol.showStatusBarItem", true);
    const view = [...main.sourceStatusViews].find((view) => view.statusBar === api);
    expect(api.addLeftTile).toHaveBeenCalledTimes(1);
    expect(bar.getLeftTiles().filter((tile) => tile.getItem() === view.element)).toEqual([
      view.tile,
    ]);
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
          main.consumeStatusBar(windowService(api)).dispose();
        }
        return tile;
      },
      addRightTile: (options) => bar.addRightTile(options),
    };
    const lease = main.consumeStatusBar(windowService(api));
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
    lease = lumine.packages.serviceHub.provide("status-bar", "2.0.0", windowService(api));
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
    const lease = lumine.packages.serviceHub.provide("status-bar", "2.0.0", windowService(api));
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
