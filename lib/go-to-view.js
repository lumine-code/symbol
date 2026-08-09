const SymbolListView = require("./symbol-list-view");

module.exports = class GoToView extends SymbolListView {
  toggle() {
    if (this.isVisible()) {
      this.cancel();
    } else {
      this.populate();
    }
  }

  detached() {
    this.abortController?.abort();
  }

  async populate() {
    let editor = lumine.workspace.getActiveTextEditor();
    if (!editor) return;

    let symbols = await this.generateSymbols(editor);

    if (symbols?.length === 0) {
      console.warn("symbol: no declarations found for the active editor");
      return;
    }

    if (symbols.length === 1) {
      if (this.openTag(symbols[0], { pending: true })) return;
    }

    // There must be multiple tags.
    await this.updateView({ items: symbols });
    this.attach();
  }

  shouldBePending() {
    return true;
  }

  async generateSymbols(editor, range = null) {
    this.abortController?.abort();
    this.abortController = new AbortController();

    return this.service.findDeclarations(editor, {
      range,
      signal: this.abortController.signal,
      listController: this.listController,
    });
  }
};
