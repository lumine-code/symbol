const Config = require("./config");
const SymbolListView = require("./symbol-list-view");
const el = require("./element-builder");
const { badge } = require("./util");

class FileView extends SymbolListView {
  elementForItem({ position, name, tag, icon, context, providerName }, options) {
    let badges = [];
    if (providerName && this.shouldShowProviderName) {
      badges.push(providerName);
    }
    if (tag) {
      badges.push(tag);
    }

    let primaryLineClasses = ["primary-line"];

    // The “primary” results line shows the symbol's name and its tag, if any.
    let primary = el(
      `div.${primaryLineClasses.join(".")}`,
      el("div.name", options.highlight(name)),
      badges &&
        el("div.badge-container", ...badges.map((b) => badge(b, { variant: this.useBadgeColors }))),
    );

    if (this.showIcons) {
      lumine.icons.applyTo(primary, this.iconTarget(icon, tag), { setData: false });
      if (!primary.classList.contains("icon")) primary.classList.add("no-icon");
    }

    // The “secondary” results line shows the symbol’s row number and its
    // context, if any.
    let secondaryLineClasses = ["secondary-line"];
    if (this.showIcons) {
      secondaryLineClasses.push("no-icon");
    }
    let secondary = el(
      `div.${secondaryLineClasses.join(".")}`,
      el("span.location", `Line ${position.row + 1}`),
      context && el("span.context", context),
    );

    return el("li.two-lines", primary, secondary);
  }

  didChangeSelection(item) {
    let quickJump = Config.get("quickJumpToFileSymbol");
    if (quickJump && item) this.openTag(item);
  }

  async didCancelSelection() {
    // The shared fetch is deliberately left running: the registry completes
    // it and warms the cache for whoever asks next.
    await this.cancel();
    let editor = this.getEditor();
    if (editor && this.initialState) {
      this.deserializeEditorState(editor, this.initialState);
    }
    this.initialState = null;
  }

  async toggle(filterTerm = "") {
    if (this.isVisible()) await this.cancel();
    let editor = this.getEditor();
    // Remember exactly where the editor is so that we can restore that state
    // if the user cancels.
    let quickJump = Config.get("quickJumpToFileSymbol");
    if (quickJump && editor) {
      this.initialState = this.serializeEditorState(editor);
    }

    // Not awaited: the list attaches right away and shows its loading
    // message while the registry fetches. A `false` resolution cancels the
    // view from inside `populate`.
    this.populate(editor);
    this.attach();
    this.selectListView.update({ query: filterTerm, selectQuery: true });
  }

  serializeEditorState(editor) {
    let editorElement = lumine.views.getView(editor);
    let scrollTop = editorElement.getScrollTop();

    return {
      bufferRanges: editor.getSelectedBufferRanges(),
      scrollTop,
    };
  }

  deserializeEditorState(editor, { bufferRanges, scrollTop }) {
    let editorElement = lumine.views.getView(editor);

    editor.setSelectedBufferRanges(bufferRanges);
    editorElement.setScrollTop(scrollTop);
  }

  getEditor() {
    return lumine.workspace.getActiveTextEditor();
  }

  getPath() {
    return this.getEditor()?.getPath();
  }

  getScopeName() {
    return this.getEditor()?.getGrammar()?.scopeName;
  }

  async populate(editor) {
    let cached = this.service.peekFileSymbols(editor);
    if (cached) {
      await this.updateView({ items: cached });
      return true;
    }

    await this.updateView({
      items: [],
      loadingMessage: "Generating symbols…",
    });

    // A provider that throws used to leave "Generating symbols…" up for the
    // life of the palette: the only clear sat on the success path.
    let symbols;
    try {
      symbols = await this.service.getFileSymbols(editor, {
        listController: this.listController,
      });
    } catch (error) {
      await this.updateView({
        loadingMessage: null,
        status: { type: "error", message: `Could not generate symbols: ${error.message}` },
      });
      throw error;
    }
    await this.updateView({ loadingMessage: null });

    if (symbols == null) {
      this.cancel();
      return false;
    }

    await this.updateView({ items: symbols });
    return true;
  }
}

module.exports = FileView;
