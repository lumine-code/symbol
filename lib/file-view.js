const Config = require("./config");
const SymbolListView = require("./symbol-list-view");
const el = require("./element-builder");
const { badge } = require("./util");

class FileView extends SymbolListView {
  constructor(stack, service) {
    super(stack, service);
    this.selectList.setSource({
      mode: "snapshot",
      loadingMessage: "Generating symbols…",
      load: () => this.loadFileSymbols(this.sourceEditor),
    });
  }

  renderItem(symbol, options) {
    let { position, name, tag, icon, context, providerName } = symbol;
    options = {
      ...options,
      matchIndices: this.sourceMatchIndices?.get(symbol) ?? options.matchIndices,
    };
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

  handleSelectionChange(item) {
    let quickJump = Config.get("quickJumpToFileSymbol");
    if (quickJump && item) this.openTag(item);
  }

  async handleCancel() {
    // The shared fetch is deliberately left running: the registry completes
    // it and warms the cache for whoever asks next.
    let editor = this.getEditor();
    if (editor && this.initialState) {
      this.deserializeEditorState(editor, this.initialState);
    }
    this.initialState = null;
  }

  async toggle(filterTerm = "") {
    if (this.isVisible()) return this.cancel();
    let editor = this.getEditor();
    if (!editor) return;
    // Remember exactly where the editor is so that we can restore that state
    // if the user cancels.
    let quickJump = Config.get("quickJumpToFileSymbol");
    if (quickJump && editor) {
      this.initialState = this.serializeEditorState(editor);
    }

    this.sourceEditor = editor;
    return this.attach({ query: filterTerm, selectQuery: true });
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

  async loadFileSymbols(editor) {
    let cached = this.service.peekFileSymbols(editor);
    if (cached) return cached;

    // A provider that throws used to leave "Generating symbols…" up for the
    // life of the palette: the only clear sat on the success path.
    let symbols;
    try {
      symbols = await this.service.getFileSymbols(editor, {
        listController: this.listController,
      });
    } catch (error) {
      throw new Error(`Could not generate symbols: ${error.message}`, { cause: error });
    }

    if (symbols == null) {
      this.selectList.cancel("symbols-unavailable");
      return undefined;
    }
    return symbols;
  }

  async openSelectedSymbol(tag) {
    const result = await super.openSelectedSymbol(tag);
    this.initialState = null;
    return result;
  }
}

module.exports = FileView;
