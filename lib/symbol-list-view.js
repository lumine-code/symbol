const Path = require("path");
const { fileURLToPath } = require("url");
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
    this.window = options.window ?? lumine.workspace.getMainWindow();
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
        renderItem: (item, options) => this.renderItem(item, options),
        commands: {
          "symbol:open-selected-symbol": {
            description: "Open the selected symbol with its default opener.",
            didDispatch: ({ detail }) =>
              this.openSelectedSymbol(detail.item, {
                pending: lumine.config.get("core.allowPendingPaneItems"),
                signal: detail.signal,
                keepOpen: detail.keepOpen,
              }),
          },
          "symbol:open-selected-with": {
            description: "Choose an opener for the symbol's local file.",
            didDispatch: ({ detail }) => this.performFileAction(detail.item, "with", detail.signal),
          },
          "symbol:open-selected-external": {
            description: "Open the symbol's local file in its external application.",
            didDispatch: ({ detail }) =>
              this.performFileAction(detail.item, "external", detail.signal),
          },
          "symbol:show-selected-in-folder": {
            description: "Reveal the symbol's local file in the system file manager.",
            didDispatch: ({ detail }) => this.performFileAction(detail.item, "show", detail.signal),
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
          ...[
            "symbol:open-selected-with",
            "symbol:open-selected-external",
            "symbol:show-selected-in-folder",
          ].map((command) => ({
            command,
            context: "item",
            group: "File",
            disposition: "close",
            when: ({ item }) => Boolean(this.fileTarget(item)),
          })),
        ],
      },
      { className: "symbol", crumb: "Symbols", window: this.window },
    );
    this.selectList = this.selectListHost.getModel();

    // Create the (hidden) modal panel eagerly: callers introspect
    // `lumine.workspace.getModalPanels()` right after the view is constructed.
    this.selectListHost.getPanel();

    this.disposables = new CompositeDisposable(
      this.selectList.onDidChangeQuery(({ query }) => this.handleQueryChange(query)),
      this.selectList.onDidChangeSelection(({ item, reason }) => {
        // A row click dispatches its Enter binding after selecting. Let that
        // command own navigation instead of opening a keyboard preview first.
        if (reason !== "click") this.handleSelectionChange(item);
      }),
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

  getSourceMatchIndices(symbol) {
    return this.sourceMatchIndices?.get(symbol);
  }

  renderItem(symbol, options) {
    let { position, name, file, icon, tag, context, directory, providerName, uri } = symbol;
    file ??= uri ?? name;
    options = {
      ...options,
      matchIndices: this.getSourceMatchIndices(symbol) ?? options.matchIndices,
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

  fileTarget(tag) {
    if (!tag) return null;
    if (tag.cell && tag.uri && !/^file:/i.test(tag.uri)) return null;
    let target = tag.path ?? (tag.file ? Path.join(tag.directory ?? "", tag.file) : tag.uri);
    target ??= this.getSourceEditor()?.getPath?.();
    if (typeof target !== "string") return null;
    let uriFragment;
    if (/^file:/i.test(target)) {
      try {
        uriFragment = new URL(target).hash || undefined;
        target = fileURLToPath(target);
      } catch {
        return null;
      }
    }
    if (!Path.isAbsolute(target)) return null;
    const position = tag.position ?? tag.range?.start;
    return {
      path: target,
      pane: this.openingPane ?? this.window.getEditorContainer().getActivePane(),
      ...(position ? { initialLine: position.row, initialColumn: position.column } : {}),
      ...(uriFragment ? { uriFragment } : {}),
    };
  }

  async performFileAction(tag, mode, signal) {
    const target = this.fileTarget(tag);
    if (!target || this.destroyed || this.window.isDestroyed() || signal?.aborted) return;
    let file;
    try {
      file = await require("node:fs").promises.stat(target.path);
    } catch {
      if (signal?.aborted || this.destroyed || this.window.isDestroyed()) return;
      throw new Error("Selected file does not exist");
    }
    if (signal?.aborted || this.destroyed || this.window.isDestroyed()) return;
    if (!file.isFile()) throw new Error("Selected path is not a file");
    if (mode === "with") {
      const opening = lumine.commands.dispatch(this.window.getElement(), "launcher:open", target);
      if (!opening) throw new Error("The Launcher package is not available.");
      return opening;
    }
    return lumine.workspace.open(target.path, {
      pane: target.pane,
      signal,
      opener: mode === "external" ? "open-external" : "open-external:show",
    });
  }

  async openSelectedSymbol(tag, options = {}) {
    if (this.destroyed) return false;
    if (tag.file && !fs.isFileSync(Path.join(tag.directory, tag.file))) {
      throw new Error("Selected file does not exist");
    }
    const target = this.fileTarget(tag);
    return this.openTag(tag, {
      ...(target ? { target: target.path, uriFragment: target.uriFragment } : {}),
      ...options,
    });
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

  async openTag(tag, { pending, target: explicitTarget, keepOpen: _keepOpen, ...options } = {}) {
    if (this.destroyed || options.signal?.aborted) return false;
    pending ??= this.shouldBePending();
    const sourceEditor = this.getSourceEditor();
    const targetPane = this.openingPane ?? this.window.getEditorContainer().getActivePane();
    const previous = sourceEditor && {
      editorId: sourceEditor.id,
      position: sourceEditor.getCursorBufferPosition(),
      file: sourceEditor.getURI(),
    };
    const position = tag.position ?? tag.range?.start;
    if (!position) return false;
    const target =
      explicitTarget ??
      (tag.cell && tag.uri
        ? tag.uri
        : (tag.path ?? (tag.file ? Path.join(tag.directory, tag.file) : tag.uri)));
    let item = sourceEditor;
    if (target) {
      item = await lumine.workspace.open(target, {
        ...options,
        pane: targetPane,
        pending,
        initialLine: position.row,
        initialColumn: position.column,
      });
      if (!item) return false;
      if (this.destroyed || options.signal?.aborted) return false;
      if (tag.cell && !tag.uri && item.revealCell) {
        await item.revealCell(tag.cell - 1, position);
        if (this.destroyed || options.signal?.aborted) return false;
      }
    } else if (!item || previous.position.isEqual(position)) {
      return false;
    } else if (item !== lumine.workspace.getActiveTextEditor()) {
      item = await lumine.workspace.open(item, { searchAllPanes: true });
      if (!item || this.destroyed) return false;
    }
    const revealedByWorkspace =
      target &&
      lumine.workspace.isTextEditor(item) &&
      item.getCursorBufferPosition().isEqual(item.clipBufferPosition(position));
    if (item.setCursorBufferPosition)
      this.moveToPosition(position, { editor: item, reveal: !revealedByWorkspace });
    if (previous) this.stack.push(previous);
    return true;
  }

  moveToPosition(
    position,
    {
      beginningOfLine = false,
      editor = this.window.getEditorContainer().getActiveEmbeddedTextEditor(),
      reveal = true,
    } = {},
  ) {
    if (!editor) return;
    editor.setCursorBufferPosition(position, { autoscroll: false });
    if (beginningOfLine) editor.moveToFirstCharacterOfLine();
    if (reveal) editor.scrollToZone();
  }

  getSourceEditor() {
    return this.window.getEditorContainer().getActiveEmbeddedTextEditor();
  }

  attach(options) {
    if (this.destroyed) return Promise.resolve();
    this.openingPane = this.window.getEditorContainer().getActivePane();
    return this.selectListHost.show(options);
  }

  isVisible() {
    return !this.destroyed && this.selectListHost.isVisible();
  }
}

module.exports = SymbolListView;
