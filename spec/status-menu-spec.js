describe("symbol source status action menu", () => {
  // Analysis fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let main, view, lease, editor;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    lumine.config.set("symbol.showStatusBarItem", true);
    editor = await lumine.workspace.open();
    main = (await lumine.packages.activatePackage("symbol")).mainModule;
    const addTile = ({ item }) => {
      lumine.workspace.getElement().appendChild(item);
      return { destroy: () => item.remove() };
    };
    lease = main.consumeStatusBar({
      observeWindows: (create) =>
        create(
          { addLeftTile: addTile, addRightTile: addTile },
          {
            window: lumine.workspace.getMainWindow(),
            document,
            editorContainer: lumine.workspace.getMainWindow().getEditorContainer(),
          },
        ),
    });
    view = [...main.sourceStatusViews].at(-1);
  });
  afterEach(async () => {
    lease.dispose();
    await lumine.packages.deactivatePackage("symbol");
  });
  it("offers the primary picker and providers report, preserving the described editor", async () => {
    const items = lumine.contextMenu
      .templateForElement(view.element)
      .filter((item) => item.command);
    expect(items.map((item) => item.command)).toEqual([
      "symbol:select-document-source",
      "symbol:show-active-providers",
    ]);
    expect(items[0].commandDetail.editor).toBe(editor);
    await lumine.workspace.open();
    const show = spyOn(main, "showDocumentSourceSelector");
    await lumine.commands.dispatch(view.element, items[0].command, items[0].commandDetail);
    expect(show).toHaveBeenCalledWith(editor, lumine.workspace.getMainWindow());
  });
  it("does not run on right click and retires its menu with the tile", () => {
    const show = spyOn(main, "showDocumentSourceSelector");
    view.element.dispatchEvent(new MouseEvent("click", { button: 2 }));
    expect(show).not.toHaveBeenCalled();
    lease.dispose();
    expect(lumine.contextMenu.templateForElement(view.element)).toEqual([]);
  });
  it("shows a real custom source-picker binding despite its context-only detail", async () => {
    const keys = lumine.keymaps.add("symbol-source-status-shortcut-spec", {
      'lumine-text-editor[data-menu-owner="source"]': {
        "ctrl-alt-1": "symbol:select-document-source",
      },
    });
    editor.getElement().setAttribute("data-menu-owner", "source");
    try {
      const menu = lumine.contextMenu.templateForElement(view.element);
      const label = process.platform === "darwin" ? "⌃⌥1" : "Ctrl+Alt+1";
      expect(menu[0].commandDetail.editor).toBe(editor);
      expect(menu[0].keyBindingLabel).toBe(label);
      const popup = lumine.contextMenu.show(view.element, menu);
      try {
        expect(popup.element.querySelector(".menu-item-keystroke").textContent).toBe(label);
      } finally {
        popup.close();
      }
      await lumine.workspace.open({
        getTitle: () => "Preview",
        element: document.createElement("div"),
      });
      expect(lumine.contextMenu.templateForElement(view.element)[0].keyBindingLabel).toBe("");
    } finally {
      keys.dispose();
    }
  });
});
