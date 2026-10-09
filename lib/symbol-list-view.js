const Path = require("path");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable } = require("lumine");

const Config = require("./config");
const el = require("./element-builder");
const { badge } = require("./util");

/**
 * The base select-list UI for symbol pickers. Fetching, caching, and provider
 * selection live in the registry; a view asks the `symbol.registry` service
 * for symbols and renders what comes back.
 */
class SymbolListView {
  constructor(stack, service, options = {}) {
    this.stack = stack;
    this.service = service;

    options = {
      emptyMessage: "No symbols found",
      ...options,
    };

    this.selectListHost = lumine.workspace.addSelectList(
      {
        ...options,
        items: [],
        getItemId: (item) => this.symbolId(item),
        search: { getFilterText: (item) => item.name },
        renderItem: this.renderItem.bind(this),
        commands: {
          "symbol:open-selected-symbol": {
            description: "Open the selected symbol.",
            didDispatch: ({ detail }) => this.openSelectedSymbol(detail.item),
          },
        },
        actions: [
          {
            command: "symbol:open-selected-symbol",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
      },
      { className: "symbol", crumb: "Symbols" },
    );
    this.selectList = this.selectListHost.getModel();

    // Create the (hidden) modal panel eagerly: callers introspect
    // `lumine.workspace.getModalPanels()` right after the view is constructed.
    this.selectListHost.getPanel();

    this.disposables = new CompositeDisposable(
      this.selectList.onDidChangeQuery(({ query }) => this.handleQueryChange(query)),
      this.selectList.onDidChangeSelection(({ item }) => this.handleSelectionChange(item)),
      this.selectList.onDidConfirmEmptySelection(() => this.handleEmptyConfirmation()),
      this.selectListHost.onDidCancel((event) => this.handleCancel(event)),
      this.selectListHost.onDidHide(() => this.handleHide()),
      Config.observe("showProviderNames", (show) => (this.shouldShowProviderName = show)),
      Config.observe("useBadgeColors", (use) => (this.useBadgeColors = use)),
      Config.observe("showIcons", (show) => (this.showIcons = show)),
    );
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController?.abort();
    await this.cancel();
    this.disposables.dispose();
    return this.selectListHost.destroy();
  }

  getElement() {
    return this.selectList.getElement();
  }

  getPanel() {
    return this.selectListHost.getPanel();
  }

  symbolId(symbol) {
    const position = symbol.position ?? symbol.range?.start;
    const end = symbol.range?.end ?? position;
    const symbolPath = symbol.path ?? Path.join(symbol.directory ?? "", symbol.file ?? "");
    return JSON.stringify([
      symbolPath,
      symbol.cell ?? null,
      symbol.name,
      position?.row ?? null,
      position?.column ?? null,
      end?.row ?? null,
      end?.column ?? null,
      symbol.tag ?? "",
      symbol.context ?? "",
    ]);
  }

  renderItem(symbol, options) {
    let { position, name, file, icon, tag, context, directory, providerName, uri } = symbol;
    file ??= uri ?? name;
    options = {
      ...options,
      matchIndices: this.sourceMatchIndices?.get(symbol) ?? options.matchIndices,
    };
    name = name.replace(/\n/g, " ");

    if (directory && lumine.project.getPaths().length > 1) {
      // More than one project root — we need to disambiguate the file paths.
      file = Path.join(Path.basename(directory), file);
    }

    let badges = [];

    if (providerName && this.shouldShowProviderName) {
      badges.push(providerName);
    }
    if (tag) badges.push(tag);

    let primaryLineClasses = ["primary-line"];

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

    let secondaryLineClasses = ["secondary-line"];
    if (this.showIcons) {
      secondaryLineClasses.push("no-icon");
    }
    let secondary = el(
      `div.${secondaryLineClasses.join(".")}`,
      el("span.location", position ? `${file}:${position.row + 1}` : file),
      context ? el("span.context", context) : null,
    );

    return el("li.two-lines", primary, secondary);
  }

  async cancel() {
    if (this.selectListHost.isVisible()) return this.selectListHost.cancel("api");
    return this.updateView({ items: [] });
  }

  iconTarget(icon, tag) {
    if (icon) {
      const name = icon.startsWith("icon-") ? icon.slice("icon-".length) : icon;
      return { name, context: "symbol" };
    }
    return { kind: tag, context: "symbol" };
  }

  async updateView(options) {
    if (this.destroyed) return;
    return this.selectList.update(options);
  }

  handleQueryChange() {
    // no-op
  }

  handleCancel() {
    // Subclasses restore any state changed by live selection here. The modal
    // host has already hidden the model and invalidated its data source.
  }

  handleEmptyConfirmation() {
    this.selectListHost.cancel("empty-selection");
  }

  async openSelectedSymbol(tag) {
    if (this.destroyed) return false;
    if (tag.file && !fs.isFileSync(Path.join(tag.directory, tag.file))) {
      throw new Error("Selected file does not exist");
    }
    return this.openTag(tag, { pending: this.shouldBePending() });
  }

  // Whether a pane opened by a view should be treated as a pending pane.
  shouldBePending() {
    return false;
  }

  handleSelectionChange() {
    // no-op
  }

  handleHide() {
    return this.updateView({ items: [] });
  }

  async openTag(tag, { pending } = {}) {
    if (this.destroyed) return false;
    pending ??= this.shouldBePending();
    const sourceEditor = this.getSourceEditor();
    const previous = sourceEditor && {
      editorId: sourceEditor.id,
      position: sourceEditor.getCursorBufferPosition(),
      file: sourceEditor.getURI(),
    };
    const position = tag.position ?? tag.range?.start;
    if (!position) return false;
    const target =
      tag.cell && tag.uri
        ? tag.uri
        : (tag.path ?? (tag.file ? Path.join(tag.directory, tag.file) : tag.uri));
    let item = sourceEditor;
    if (target) {
      item = await lumine.workspace.open(target, {
        pending,
        initialLine: position.row,
        initialColumn: position.column,
      });
      if (!item) return false;
      if (this.destroyed) return false;
      if (tag.cell && !tag.uri && item.revealCell) {
        await item.revealCell(tag.cell - 1, position);
        if (this.destroyed) return false;
      }
    } else if (!item || previous.position.isEqual(position)) {
      return false;
    } else if (item !== lumine.workspace.getActiveTextEditor()) {
      item = await lumine.workspace.open(item, { searchAllPanes: true });
      if (!item || this.destroyed) return false;
    }
    if (item.setCursorBufferPosition) this.moveToPosition(position, { editor: item });
    if (previous) this.stack.push(previous);
    return true;
  }

  moveToPosition(
    position,
    { beginningOfLine = false, editor = lumine.workspace.getActiveTextEditor() } = {},
  ) {
    if (!editor) return;
    editor.setCursorBufferPosition(position, { autoscroll: false });
    if (beginningOfLine) editor.moveToFirstCharacterOfLine();
    editor.scrollToCursorPosition({ center: true });
  }

  getSourceEditor() {
    return lumine.workspace.getActiveTextEditor();
  }

  attach(options) {
    if (this.destroyed) return Promise.resolve();
    return this.selectListHost.show(options);
  }

  isVisible() {
    return !this.destroyed && this.selectListHost.isVisible();
  }
}

module.exports = SymbolListView;
