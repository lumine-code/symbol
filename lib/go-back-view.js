const SymbolListView = require("./symbol-list-view");

// TODO: Does this really need to extend SymbolListView?
module.exports = class GoBackView extends SymbolListView {
  async toggle() {
    let previous = this.stack.pop();
    if (!previous) return;

    let restorePosition = () => {
      if (!previous.position) return;
      this.moveToPosition(previous.position, { beginningOfLine: false });
    };

    let allEditors = lumine.workspace.getTextEditors();
    let previousEditor = allEditors.find((e) => e.id === previous.editorId);

    if (previousEditor) {
      const editor = await lumine.workspace.open(previousEditor, { searchAllPanes: true });
      if (editor) restorePosition();
    } else if (previous.file) {
      // The editor is not there anymore; e.g., a package like `zentabs` might
      // have automatically closed it when a new editor view was opened. So we
      // should restore it if we can.
      // An open can decline — an unreadable path, a full workspace center.
      // `restorePosition` works on whichever editor is active, so without this
      // going back would move the cursor in the wrong file.
      const editor = await lumine.workspace.open(previous.file, { searchAllPanes: true });
      if (editor) restorePosition();
    }
  }
};
