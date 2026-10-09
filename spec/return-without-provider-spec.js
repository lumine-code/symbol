describe("Return from a definition after its provider disappears", () => {
  let main, editor, provider;
  async function waitForPosition(row, column) {
    const deadline = Date.now() + 1000;
    while (!editor.getCursorBufferPosition().isEqual([row, column]) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("call\nline\nline\ndefinition\n");
    editor.setCursorBufferPosition([0, 2]);
    provider = lumine.packages.serviceHub.provide("symbol.definition-provider", "1.0.0", {
      name: "Owned Definition",
      packageName: "owned-definition",
      canProvideDefinitions: () => true,
      getDefinitions: () => [{ name: "definition", position: [3, 0] }],
    });
    await lumine.commands.dispatch(editor.getElement(), "symbol:go-to-definition");
    await waitForPosition(3, 0);
    expect(editor.getCursorBufferPosition()).toEqual([3, 0]);
    expect(main.stack.length).toBe(1);
  });

  afterEach(async () => {
    provider?.dispose();
    if (lumine.packages.isPackageActive("symbol"))
      await lumine.packages.deactivatePackage("symbol");
    if (lumine.packages.isPackageLoaded("symbol")) await lumine.packages.unloadPackage("symbol");
    editor?.destroy();
    main = editor = provider = null;
  });

  it("returns through the normal command using its existing history after provider disposal", async () => {
    provider.dispose();
    expect(main.registry.hasProviders("definition")).toBe(false);
    spyOn(lumine.notifications, "addWarning");
    await lumine.commands.dispatch(editor.getElement(), "symbol:return-from-definition");
    await waitForPosition(0, 2);
    expect(editor.getCursorBufferPosition()).toEqual([0, 2]);
    expect(main.stack.length).toBe(0);
    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });

  it("keeps return navigation working while the provider remains connected", async () => {
    await lumine.commands.dispatch(editor.getElement(), "symbol:return-from-definition");
    await waitForPosition(0, 2);
    expect(editor.getCursorBufferPosition()).toEqual([0, 2]);
    expect(main.stack.length).toBe(0);
  });
});
