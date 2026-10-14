const path = require("path");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable } = require("lumine");

describe("symbol file opening actions", () => {
  let view, source, pane, stack, leases, external;
  const filename = path.join(__dirname, "fixtures", "js", "sample.js");
  const tag = { name: "Selected Symbol", path: filename, position: { row: 2, column: 1 } };

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("symbol");
    external = (await lumine.packages.activatePackage("open-external")).mainModule;
    source = await lumine.workspace.open(filename, { opener: "text-editor" });
    pane = lumine.workspace.getActivePane().splitRight();
    pane.activate();
    stack = [];
    const SymbolListView = require("../lib/symbol-list-view");
    view = new SymbolListView(stack, {});
    view.getSourceEditor = () => source;
    leases = new CompositeDisposable();
    await view.updateView({ items: [tag] });
    await view.attach();
  });

  afterEach(async () => {
    leases.dispose();
    await view.destroy();
  });

  async function click(modifiers) {
    const done = new Promise((resolve) => {
      const lease = view.selectList.onDidFinishAction((result) => {
        lease.dispose();
        resolve(result);
      });
    });
    view.selectList
      .getElement()
      .querySelector('[role="option"]')
      .dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: 0,
          ...modifiers,
        }),
      );
    return done;
  }

  it("passes the file, symbol position and captured pane to Open With", async () => {
    await lumine.packages.deactivatePackage("open-with");
    const choose = jasmine.createSpy("choose symbol opener");
    leases.add(
      lumine.commands.add("lumine-workspace", {
        "open-with:toggle": (event) => {
          event.stopPropagation();
          choose(event.detail);
        },
      }),
    );
    expect((await click({ altKey: true })).status).toBe("success");
    expect(choose).toHaveBeenCalledOnceWith({
      path: filename,
      pane,
      initialLine: 2,
      initialColumn: 1,
    });
  });

  it("opens pending text at the symbol and records navigation when automatic previews are disabled", async () => {
    lumine.config.set("core.allowPendingPaneItems", false);
    expect((await click({ shiftKey: true })).status).toBe("success");
    const editor = pane.getActiveItem();
    expect(editor.getPath()).toBe(filename);
    expect(editor.getCursorBufferPosition()).toEqual(editor.clipBufferPosition([2, 1]));
    expect(pane.getPendingItem()).toBe(editor);
    expect(stack.length).toBe(1);
    expect(stack[0].editorId).toBe(source.id);
  });

  it("honors a registered default viewer on an ordinary click", async () => {
    const viewer = {
      element: document.createElement("div"),
      getURI: () => filename,
      getPath: () => filename,
      getTitle: () => "Symbol Viewer",
    };
    leases.add(
      lumine.workspace.addPathOpener({
        id: "symbol-test-default",
        label: "Symbol Viewer",
        canOpen: (uri) => uri === filename,
        open: () => viewer,
      }),
    );
    lumine.config.set("core.allowPendingPaneItems", true);
    expect((await click({})).status).toBe("success");
    expect(pane.getActiveItem()).toBe(viewer);
    expect(pane.getPendingItem()).toBe(viewer);
    expect(stack.length).toBe(1);
  });

  it("routes system gestures to external handlers", async () => {
    const open = spyOn(external, "openExternal").and.resolveTo("");
    const show = spyOn(external, "showInFolder").and.resolveTo("");
    expect((await click({ ctrlKey: true, altKey: true })).status).toBe("success");
    await view.updateView({ items: [tag] });
    await view.attach();
    expect((await click({ ctrlKey: true, shiftKey: true })).status).toBe("success");
    expect(open).toHaveBeenCalledOnceWith(filename);
    expect(show).toHaveBeenCalledOnceWith(filename);
  });

  it("retains virtual notebook navigation and does not stat its URI as a local pending target", async () => {
    const uri = "jupyter://notebook/spec-cell";
    const virtual = {
      name: "Notebook Symbol",
      uri,
      cell: "cell-id",
      position: { row: 1, column: 0 },
    };
    const viewer = {
      element: document.createElement("div"),
      getURI: () => uri,
      getTitle: () => "Cell",
    };
    leases.add(lumine.workspace.addOpener((value) => (value === uri ? viewer : undefined)));
    const stat = spyOn(fs, "isFileSync").and.callThrough();
    await view.updateView({ items: [virtual] });
    expect((await view.selectList.runAction("symbol:open-selected-pending")).status).toBe(
      "unavailable",
    );
    expect((await view.selectList.confirmSelection()).status).toBe("success");
    expect(pane.getActiveItem()).toBe(viewer);
    expect(stat.calls.allArgs().some(([value]) => value === uri)).toBe(false);
  });
});
