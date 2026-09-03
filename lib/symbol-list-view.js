const Path = require("path");
const fs = require("@lumine-code/fs-plus");
const { CompositeDisposable, Point } = require("lumine");

const Config = require("./config");
const ListController = require("./list-controller");
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

    this.selectList = lumine.workspace.buildSelectList({
      ...options,
      className: "symbol",
      crumb: "Symbols",
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
    });

    this.listController = new ListController(this.selectList);

    // Create the (hidden) modal panel eagerly: callers introspect
    // `lumine.workspace.getModalPanels()` right after the view is constructed.
    this.selectList.getPanel();

    this.disposables = new CompositeDisposable(
      this.selectList.onDidChangeQuery(({ query }) => this.handleQueryChange(query)),
      this.selectList.onDidChangeSelection(({ item }) => this.handleSelectionChange(item)),
      this.selectList.onDidConfirmEmptySelection(() => this.handleEmptyConfirmation()),
      this.selectList.onDidCancel((event) => this.handleCancel(event)),
      this.selectList.onDidHide(() => this.handleHide()),
      Config.observe("showProviderNames", (show) => (this.shouldShowProviderName = show)),
      Config.observe("useBadgeColors", (use) => (this.useBadgeColors = use)),
      Config.observe("showIcons", (show) => (this.showIcons = show)),
    );
  }

  async destroy() {
    await this.cancel();
    this.disposables.dispose();
    return this.selectList.destroy();
  }

  getElement() {
    return this.selectList.getElement();
  }

  getPanel() {
    return this.selectList.getPanel();
  }

  symbolId(symbol) {
    const position = symbol.position ?? symbol.range?.start;
    const end = symbol.range?.end ?? position;
    const symbolPath = symbol.path ?? Path.join(symbol.directory ?? "", symbol.file ?? "");
    return JSON.stringify([
      symbol.providerId ?? "",
      symbol.providerName ?? "",
      symbolPath,
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
    let { position, name, file, icon, tag, context, directory, providerName } = symbol;
    options = {
      ...options,
      matchIndices: this.sourceMatchIndices?.get(symbol) ?? options.matchIndices,
    };
    name = name.replace(/\n/g, " ");

    if (lumine.project.getPaths().length > 1) {
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
    if (this.selectList.isVisible()) return this.selectList.cancel("api");
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
    return this.selectList.update(options);
  }

  handleQueryChange() {
    // no-op
  }

  handleCancel() {
    // Subclasses restore any state changed by live selection here. The model
    // has already hidden itself and invalidated its data source.
  }

  handleEmptyConfirmation() {
    this.selectList.cancel("empty-selection");
  }

  async openSelectedSymbol(tag) {
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

  openTag(tag, { pending } = {}) {
    pending ??= this.shouldBePending();
    let editor = lumine.workspace.getActiveTextEditor();
    let previous;
    if (editor) {
      previous = {
        editorId: editor.id,
        position: editor.getCursorBufferPosition(),
        file: editor.getURI(),
      };
    }

    let { position, range } = tag;
    if (!position) position = this.getTagLine(tag);

    let result = false;
    if (tag.file) {
      // Open a different file, then jump to a position.
      lumine.workspace
        .open(Path.join(tag.directory, tag.file), { pending, activatePane: false })
        .then((editor) => {
          // An open can decline — an unreadable path, a full workspace center.
          // `moveToPosition` works on whichever editor is active, so without
          // this the cursor jumps to the symbol's position in the wrong file.
          if (editor && position) {
            return this.moveToPosition(position, { range });
          }
          return undefined;
        });
      result = true;
    } else if (position && previous && !previous.position.isEqual(position)) {
      // Jump to a position in the same file.
      this.moveToPosition(position, { range });
      result = true;
    }
    if (result) this.stack.push(previous);
    return result;
  }

  moveToPosition(position, { beginningOfLine = true } = {}) {
    let editor = lumine.workspace.getActiveTextEditor();
    if (editor) {
      editor.setCursorBufferPosition(position, { autoscroll: false });
      if (beginningOfLine) {
        editor.moveToFirstCharacterOfLine();
      }
      editor.scrollToCursorPosition({ center: true });
    }
  }

  attach(options) {
    return this.selectList.show(options);
  }

  isVisible() {
    return this.selectList.isVisible();
  }

  // TODO: What on earth is this? Can we possibly still need it?
  getTagLine(tag) {
    if (!tag) return undefined;

    if (tag.lineNumber) {
      return new Point(tag.lineNumber - 1, 0);
    }

    if (!tag.pattern) return undefined;
    let pattern = tag.pattern.replace(/(^\/\^)|(\$\/$)/g, "").trim();
    if (!pattern) return undefined;

    const file = Path.join(tag.directory, tag.file);
    if (!fs.isFileSync(file)) return undefined;

    let iterable = fs.readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < iterable.length; index++) {
      let line = iterable[index];
      if (pattern === line.trim()) {
        return new Point(index, 0);
      }
    }

    return undefined;
  }
}

module.exports = SymbolListView;
