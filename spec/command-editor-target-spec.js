const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

beforeEach(() => {
  for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
    if (!jasmine.isSpy(lumine.shell[method])) spyOn(lumine.shell, method).and.resolveTo();
  if (!jasmine.isSpy(lumine.application.openWindow))
    spyOn(lumine.application, "openWindow").and.resolveTo();
});

describe("Symbol command editor targets", () => {
  let main, first, second, scratch, temporary, leases, calls;
  beforeEach(async () => {
    jasmine.useRealClock();
    if (lumine.packages.isPackageLoaded("symbol")) await lumine.packages.unloadPackage("symbol");
    temporary = fs.realpathSync.native(os.tmpdir());
    scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(temporary, "symbol-targets-")));
    for (const name of ["first.txt", "second.txt"])
      fs.writeFileSync(path.join(scratch, name), "call\nbody\nbody\ndefinition\n");
    lumine.project.setPaths([scratch]);
    lumine.config.set("symbol.showStatusBarItem", false);
    lumine.config.set("symbol.quickJumpToFileSymbol", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    first = await lumine.workspace.open(path.join(scratch, "first.txt"));
    const pane = lumine.workspace.paneForItem(first);
    pane.splitRight();
    second = await lumine.workspace.open(path.join(scratch, "second.txt"));
    pane.activate();
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
    calls = jasmine.createSpy("lookup command editor");
    leases = [
      lumine.packages.serviceHub.provide("symbol.document-provider", "1.0.0", {
        name: "Owned document symbols",
        packageName: "owned-document-symbols",
        getDocumentSymbolSources: () => [
          {
            id: "owned",
            name: "Owned",
            shortLabel: "OS",
            score: 1,
            state: "ready",
            execution: "local",
          },
        ],
        getDocumentSymbols: (editor) => {
          calls(editor);
          return [{ name: path.basename(editor.getPath()), position: [3, 0] }];
        },
      }),
      lumine.packages.serviceHub.provide("symbol.definition-provider", "1.0.0", {
        name: "Owned definitions",
        packageName: "owned-definitions",
        canProvideDefinitions: () => true,
        getDefinitions: (editor) => {
          calls(editor);
          return [{ name: "definition", path: editor.getPath(), position: [3, 0] }];
        },
      }),
    ];
  });
  afterEach(async () => {
    for (const lease of leases ?? []) lease.dispose();
    if (lumine.packages.isPackageLoaded("symbol")) await lumine.packages.unloadPackage("symbol");
    first?.destroy();
    second?.destroy();
    lumine.project.setPaths([]);
    await lumine.fileWatchClient.settlePendingTeardown();
    if (path.dirname(fs.realpathSync.native(scratch)) !== temporary)
      throw Error("Symbol target cleanup escaped its private root");
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  it("lists the symbols of the inactive dispatch editor", async () => {
    expect(lumine.workspace.getActiveTextEditor()).toBe(first);
    await lumine.commands.dispatch(second.getElement(), "symbol:toggle-file-symbols");
    await conditionPromise(
      () =>
        main.fileView?.selectList.getItems().length === 1 && !main.fileView.selectList.isLoading(),
    );
    expect(calls.calls.mostRecent().args[0]).toBe(second);
    expect(main.fileView.sourceEditor).toBe(second);
    expect(main.fileView.selectList.getItems()[0].name).toBe("second.txt");
  });
  it("resolves a definition from the inactive dispatch editor and records that origin", async () => {
    await lumine.commands.dispatch(second.getElement(), "symbol:go-to-definition");
    await conditionPromise(() => calls.calls.count() === 1 && main.stack.length === 1);
    expect(calls.calls.mostRecent().args[0]).toBe(second);
    const destination = lumine.workspace.getActiveTextEditor();
    expect(destination.getPath()).toBe(second.getPath());
    expect(destination.getCursorBufferPosition()).toEqual([3, 0]);
    expect(first.getCursorBufferPosition()).toEqual([0, 0]);
    expect(main.stack[0].editorId).toBe(second.id);
  });
  it("keeps the ordinary active editor definition lookup", async () => {
    await lumine.commands.dispatch(first.getElement(), "symbol:go-to-definition");
    await conditionPromise(() => main.stack.length === 1);
    expect(calls.calls.mostRecent().args[0]).toBe(first);
    expect(first.getCursorBufferPosition()).toEqual([3, 0]);
    expect(main.stack[0].editorId).toBe(first.id);
  });
  it("opens active file symbols from a focused unrelated surface", async () => {
    const button = document.createElement("button");
    lumine.workspace.getElement().appendChild(button);
    try {
      button.focus();
      await lumine.commands.dispatch(button, "symbol:toggle-file-symbols");
      await conditionPromise(() => main.fileView?.selectList.getItems().length === 1);
      expect(calls.calls.mostRecent().args[0]).toBe(first);
      expect(main.fileView.sourceEditor).toBe(first);
    } finally {
      button.remove();
    }
  });
});
