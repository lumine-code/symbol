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

    return this.presentSymbols(editor, symbols);
  }

  async presentSymbols(editor, symbols) {
    if (!symbols) return;
    if (symbols.length === 0) {
      if (this.requestStatus === "unavailable") {
        lumine.notifications.addWarning(
          "No active language backend can resolve definitions for this document.",
        );
      } else if (this.requestStatus === "error") {
        lumine.notifications.addWarning("The language backend could not retrieve a definition.");
      } else {
        lumine.notifications.addInfo("No definition found for the symbol under the cursor.");
      }
      return;
    }

    if (symbols.length === 1) {
      if (await this.openTag(symbols[0], { pending: true })) return;
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
    this.requestStatus = null;

    return this.service.findDefinitions(editor, {
      range,
      signal: this.abortController.signal,
      onStatus: ({ state }) => {
        this.requestStatus = state;
      },
    });
  }
};
