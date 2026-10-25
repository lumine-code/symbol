describe("symbol presentation windows", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
  });
  afterEach(async () => {
    await lumine.workspace.discardEditorWindows();
  });

  it("shares the registry while keeping picker hosts and navigation stacks local", async () => {
    const workspace = lumine.workspace;
    const primary = workspace.getMainWindow();
    const extra = await workspace.openEditorWindow({ show: false });
    const first = main.createFileView(primary);
    const second = main.createFileView(extra);
    expect(first.service).toBe(second.service);
    expect(first.stack).not.toBe(second.stack);
    expect(first.selectListHost.getPanel().getElement().ownerDocument).toBe(document);
    expect(second.selectListHost.getPanel().getElement().ownerDocument).toBe(extra.getDocument());
    const owned = spyOn(second, "destroy").and.callThrough();
    await extra.close();
    expect(owned).toHaveBeenCalledTimes(1);
    expect(main.createFileView(primary)).toBe(first);
  });
});
