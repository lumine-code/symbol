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

    this.selectListView = lumine.workspace.buildSelectList({
      ...options,
      className: "symbol",
      crumb: "Symbols",
      panelItem: this,
      items: [],
      filterKeyForItem: (item) => item.name,
      elementForItem: this.elementForItem.bind(this),
      didChangeQuery: this.didChangeQuery.bind(this),
      didChangeSelection: this.didChangeSelection.bind(this),
      didConfirmSelection: this.didConfirmSelection.bind(this),
      didConfirmEmptySelection: this.didConfirmEmptySelection.bind(this),
      didCancelSelection: this.didCancelSelection.bind(this),
    });

    this.selectListViewOptions = options;

    this.listController = new ListController(this.selectListView);

    this.element = this.selectListView.element;

    // Create the (hidden) modal panel eagerly: callers introspect
    // `lumine.workspace.getModalPanels()` right after the view is constructed.
    this.selectListView.getPanel();

    this.configDisposable = new CompositeDisposable(
      Config.observe("showProviderNames", (show) => (this.shouldShowProviderName = show)),
      Config.observe("useBadgeColors", (use) => (this.useBadgeColors = use)),
      Config.observe("showIcons", (show) => (this.showIcons = show)),
    );
  }

  async destroy() {
    await this.cancel();
    this.configDisposable.dispose();
    return this.selectListView.destroy();
  }

  getFilterKey() {
    return "name";
  }

  elementForItem({ position, name, file, icon, tag, context, directory, providerName }, options) {
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
    // A provider naming its own icon still wins; everything else is the
    // registry's kind vocabulary, which badges a kind it has no glyph for
    // rather than showing nothing.
    if (this.showIcons && icon) primaryLineClasses.push("icon", icon);

    let primary = el(
      `div.${primaryLineClasses.join(".")}`,
      el("div.name", options.highlight(name)),
      badges &&
        el("div.badge-container", ...badges.map((b) => badge(b, { variant: this.useBadgeColors }))),
    );

    if (this.showIcons) {
      if (!icon) {
        lumine.icons.applyTo(primary, { kind: tag, context: "symbol" }, { setData: false });
      }
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
    if (!this.isCanceling) {
      this.isCanceling = true;
      await this.updateView({ items: [] });
      this.selectListView.hide();
      this.isCanceling = false;
    }
  }

  async updateView(options) {
    this.selectListView.update(options);
  }

  didChangeQuery() {
    // no-op
  }

  didCancelSelection() {
    this.cancel();
  }

  didConfirmEmptySelection() {
    this.cancel();
  }

  async didConfirmSelection(tag) {
    if (tag.file && !fs.isFileSync(Path.join(tag.directory, tag.file))) {
      await this.updateView({
        status: { type: "error", message: "Selected file does not exist", duration: 2000 },
      });
    } else {
      await this.cancel();
      this.openTag(tag, { pending: this.shouldBePending() });
    }
  }

  // Whether a pane opened by a view should be treated as a pending pane.
  shouldBePending() {
    return false;
  }

  didChangeSelection() {
    // no-op
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

  attach() {
    this.selectListView.reset();
    this.selectListView.show();
  }

  isVisible() {
    return this.selectListView.isVisible();
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
