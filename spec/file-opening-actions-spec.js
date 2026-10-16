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

  it("passes the file, symbol position and captured pane to Launcher", async () => {
    await lumine.packages.deactivatePackage("launcher");
    const choose = jasmine.createSpy("choose symbol opener");
    leases.add(
      lumine.commands.add("lumine-workspace", {
        "launcher:open": (event) => {
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

  for (const modifiers of [{ shiftKey: true }, { ctrlKey: true, shiftKey: true }]) {
    it(`selects without opening for ${modifiers.ctrlKey ? "Ctrl+Shift" : "Shift"}-click`, async () => {
      const list = view.selectList;
      const selected = list.getItems()[0];
      await list.selectNone();
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const action = spyOn(list, "runAction").and.callThrough();
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...modifiers,
      });
      list.getElement().querySelector('[role="option"]').dispatchEvent(event);
      await Promise.resolve();

      expect(event.defaultPrevented).toBe(true);
      expect(list.getSelectedItem()).toBe(selected);
      expect(action).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(view.selectListHost.isVisible()).toBe(true);
    });
  }

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
    expect((await click({ altKey: true, shiftKey: true })).status).toBe("success");
    expect(open).toHaveBeenCalledOnceWith(filename);
    expect(show).toHaveBeenCalledOnceWith(filename);
  });

  it("retains virtual notebook navigation and does not stat its URI as a local file target", async () => {
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
    expect((await view.selectList.runAction("symbol:open-selected-with")).status).toBe(
      "unavailable",
    );
    expect((await view.selectList.confirmSelection()).status).toBe("success");
    expect(pane.getActiveItem()).toBe(viewer);
    expect(stat.calls.allArgs().some(([value]) => value === uri)).toBe(false);
  });

  it("describes file actions without consulting the filesystem", async () => {
    const stat = spyOn(fs, "isFileSync").and.throwError("Unexpected presentation stat");
    const asyncStat = spyOn(require("node:fs").promises, "stat").and.throwError(
      "Unexpected presentation stat",
    );
    expect(view.fileTarget(tag).path).toBe(filename);
    for (const command of [
      "symbol:open-selected-with",
      "symbol:open-selected-external",
      "symbol:show-selected-in-folder",
    ]) {
      expect((await view.selectList.getActionAvailability(command)).status).toBe("available");
    }
    expect(stat).not.toHaveBeenCalled();
    expect(asyncStat).not.toHaveBeenCalled();
  });

  it("validates the current file only when an action is executed", async () => {
    const stat = spyOn(require("node:fs").promises, "stat").and.rejectWith(new Error("missing"));
    expect(view.fileTarget(tag).path).toBe(filename);
    expect(stat).not.toHaveBeenCalled();
    await expectAsync(view.performFileAction(tag, "external")).toBeRejectedWithError(
      "Selected file does not exist",
    );
    expect(stat).toHaveBeenCalledOnceWith(filename);
  });

  it("resolves chooser, external and reveal keys without a separate pending binding", () => {
    const target = view.selectList.getQueryEditor().getElement();
    for (const [keystrokes, command] of [
      ["alt-enter", "symbol:open-selected-with"],
      ["ctrl-alt-enter", "symbol:open-selected-external"],
      ["alt-shift-enter", "symbol:show-selected-in-folder"],
    ])
      expect(lumine.keymaps.findKeyBindings({ target, keystrokes })[0]?.command).toBe(command);
    for (const keystrokes of ["shift-enter", "ctrl-shift-enter"])
      expect(
        lumine.keymaps
          .findKeyBindings({ target, keystrokes })
          .some((binding) => binding.command.startsWith("symbol:")),
      ).toBe(false);
  });
});
