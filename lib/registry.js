const { CompositeDisposable, Emitter, Point, Range } = require("lumine");
const Path = require("path");
const Config = require("./config");
const ProviderBroker = require("./provider-broker");

module.exports = class Registry {
  constructor() {
    this.broker = new ProviderBroker();
    this.emitter = new Emitter();
    this.cache = new Map();
    this.stale = new Set();
    this.inflight = new Map();
    this.queries = new Map();
    this.editorSubscriptions = new Map();
    this.destroyed = false;
    this.subscriptions = new CompositeDisposable(
      this.broker.onDidChangeProviders(({ role }) => {
        if (role === "document") this.invalidateAll();
        if (role === "workspace") {
          this.abortQueries("workspace");
          this.emitter.emit("did-invalidate-workspace-symbols");
        }
        if (role === "definition") this.abortQueries("definition");
        this.emitter.emit("did-change-providers");
      }),
      this.broker.onDidInvalidateDocumentSymbols(({ editor }) =>
        editor ? this.invalidateEditor(editor) : this.invalidateAll(),
      ),
      this.broker.onDidInvalidateWorkspaceSymbols(() => {
        this.abortQueries("workspace");
        this.emitter.emit("did-invalidate-workspace-symbols");
      }),
      Config.onDidChange(() => this.invalidateAll()),
      lumine.project.onDidChangePaths(() => {
        this.abortQueries();
        this.emitter.emit("did-invalidate-workspace-symbols");
      }),
    );
    this.editorsSubscription = lumine.workspace.observeTextEditors((editor) => {
      if (this.editorSubscriptions.has(editor)) return;
      const buffer = editor.getBuffer();
      const invalidate = () => this.invalidateEditor(editor);
      this.editorSubscriptions.set(
        editor,
        new CompositeDisposable(
          editor.onDidChangeGrammar(invalidate),
          editor.onDidSave(invalidate),
          editor.onDidChangePath(invalidate),
          buffer.onDidReload(invalidate),
          buffer.onDidChangeText(() => {
            this.stale.add(editor);
            this.abortInflight(editor);
          }),
          buffer.onDidStopChanging(invalidate),
          editor.onDidDestroy(() => this.forgetEditor(editor)),
          buffer.onDidDestroy(() => {
            this.forgetEditor(editor);
            this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
          }),
        ),
      );
    });
  }

  addDocumentProviders(...providers) {
    this.broker.add("document", ...providers);
  }
  removeDocumentProviders(...providers) {
    this.broker.remove("document", ...providers);
  }
  addWorkspaceProviders(...providers) {
    this.broker.add("workspace", ...providers);
  }
  removeWorkspaceProviders(...providers) {
    this.broker.remove("workspace", ...providers);
  }
  addDefinitionProviders(...providers) {
    this.broker.add("definition", ...providers);
  }
  removeDefinitionProviders(...providers) {
    this.broker.remove("definition", ...providers);
  }
  hasProviders(role) {
    return this.broker.providers[role]?.length > 0;
  }
  providerDescriptors() {
    return this.broker.descriptors();
  }
  onDidChangeProviders(callback) {
    return this.emitter.on("did-change-providers", callback);
  }
  onDidInvalidateFileSymbols(callback) {
    return this.emitter.on("did-invalidate-file-symbols", callback);
  }
  onDidInvalidateWorkspaceSymbols(callback) {
    return this.emitter.on("did-invalidate-workspace-symbols", callback);
  }

  abortInflight(editor) {
    const entry = this.inflight.get(editor);
    if (!entry) return;
    this.inflight.delete(editor);
    entry.controller.abort();
  }

  abortQueries(role) {
    for (const [controller, queryRole] of this.queries) {
      if (!role || role === queryRole) controller.abort();
    }
  }

  forgetEditor(editor) {
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.stale.delete(editor);
    this.editorSubscriptions.get(editor)?.dispose();
    this.editorSubscriptions.delete(editor);
  }

  invalidateEditor(editor) {
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.stale.delete(editor);
    this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
  }

  invalidateAll() {
    for (const editor of [...this.inflight.keys()]) this.abortInflight(editor);
    this.cache.clear();
    this.stale.clear();
    this.emitter.emit("did-invalidate-file-symbols", { editor: null, provider: null });
  }

  peekFileBundle(editor) {
    return this.stale.has(editor) ? null : (this.cache.get(editor) ?? null);
  }
  peekFileSymbols(editor) {
    return this.peekFileBundle(editor)?.flat ?? null;
  }
  peekFileSymbolTree(editor) {
    const bundle = this.peekFileBundle(editor);
    return bundle ? this.treeForBundle(bundle) : null;
  }
  getFileSymbols(editor) {
    return this.getFileBundle(editor).then((bundle) => bundle?.flat ?? null);
  }
  getFileSymbolTree(editor) {
    return this.getFileBundle(editor).then((bundle) =>
      bundle ? this.treeForBundle(bundle) : null,
    );
  }
  createFileBundle(symbols) {
    return { flat: symbols, tree: null };
  }
  treeForBundle(bundle) {
    bundle.tree ??= this.buildFileSymbolTree(bundle.flat);
    return bundle.tree;
  }

  getFileBundle(editor) {
    if (this.destroyed || !editor || editor.isDestroyed()) return Promise.resolve(null);
    const cached = this.peekFileBundle(editor);
    if (cached) return Promise.resolve(cached);
    const inflight = this.inflight.get(editor);
    if (inflight) return inflight.promise;
    const controller = new AbortController();
    const entry = { controller };
    entry.promise = this.runFileFetch(editor, controller.signal).finally(() => {
      if (this.inflight.get(editor) === entry) this.inflight.delete(editor);
    });
    this.inflight.set(editor, entry);
    return entry.promise;
  }

  async runFileFetch(editor, signal) {
    const candidates = await this.broker.select("document", editor, signal);
    for (const provider of candidates) {
      if (signal.aborted) return null;
      const result = await this.request(provider, signal, (request) =>
        provider.getDocumentSymbols(editor, request),
      );
      if (signal.aborted) return null;
      if (!this.broker.providers.document.includes(provider) || !result.ok) continue;
      const symbols = this.normalizedSymbols(result.symbols, provider);
      if (result.symbols.length && !symbols.length) continue;
      symbols.sort((a, b) => a.position.compare(b.position));
      const bundle = this.createFileBundle(symbols);
      this.cache.set(editor, bundle);
      this.stale.delete(editor);
      return bundle;
    }
    return null;
  }

  // Every attempt has its own budget. A timed-out server cannot consume the
  // fallback's budget or publish a late result into a newer buffer generation.
  async request(provider, parentSignal, run, extra = {}) {
    if (parentSignal.aborted || this.destroyed) return { ok: false };
    const controller = new AbortController();
    const timeoutMs = Config.get("providerTimeout");
    let timer;
    let abort;
    let settled = false;
    const cancelled = new Promise((resolve) => {
      abort = () => {
        controller.abort();
        resolve({ ok: false });
      };
      parentSignal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) return null;
            const request = { ...extra, signal: controller.signal, timeoutMs };
            for (const method of ["onSymbols", "onStatus"]) {
              if (extra[method])
                request[method] = (value) => {
                  if (!settled && !controller.signal.aborted) extra[method](value);
                };
            }
            return run(request);
          })
          .then((symbols) => {
            if (controller.signal.aborted || symbols === null) return { ok: false };
            if (!Array.isArray(symbols)) throw new Error("Provider did not return a symbol array");
            return { ok: true, symbols };
          }),
        cancelled,
      ]);
    } catch (error) {
      if (!parentSignal.aborted && !controller.signal.aborted)
        console.error("symbol: " + provider.name + ": " + error.message);
      return { ok: false };
    } finally {
      settled = true;
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", abort);
    }
  }

  normalizedSymbols(symbols, provider, { workspace = false } = {}) {
    const result = [];
    const paths = new Map();
    for (const source of symbols) {
      if (!this.isValidSymbol(source)) {
        console.warn("symbol: invalid symbol", source);
        continue;
      }
      if (workspace && !(source.path || source.uri || (source.directory && source.file))) {
        console.warn("symbol: workspace symbol has no location", source);
        continue;
      }
      const symbol = { ...source };
      try {
        this.normalizeSymbol(symbol, provider, paths);
        result.push(symbol);
      } catch (error) {
        console.warn("symbol: invalid symbol location", error.message);
      }
    }
    return result;
  }

  uniqueWorkspaceSymbols(symbols) {
    const seen = new Set();
    return symbols.filter((symbol) => {
      let location =
        symbol.path ?? (symbol.file ? Path.join(symbol.directory, symbol.file) : symbol.uri);
      if (symbol.path || symbol.file) {
        location = Path.normalize(location);
        if (process.platform === "win32") location = location.toLowerCase();
      }
      const key = JSON.stringify([
        location,
        symbol.cell ?? null,
        symbol.name,
        symbol.tag ?? null,
        symbol.position.row,
        symbol.position.column,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  beginQuery(signal, role) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.queries.set(controller, role);
    return {
      signal: controller.signal,
      abort,
      finish: () => {
        controller.abort();
        signal?.removeEventListener("abort", abort);
        this.queries.delete(controller);
      },
    };
  }

  async searchWorkspace(query = "", options = {}) {
    if (this.destroyed) return null;
    const run = this.beginQuery(options.signal, "workspace");
    const providers = [...this.broker.providers.workspace];
    const results = new Map();
    const states = new Map();
    const paths = [...lumine.project.getPaths()];
    const snapshot = () =>
      this.uniqueWorkspaceSymbols(providers.flatMap((provider) => results.get(provider) ?? []));
    const status = () => {
      if (run.signal.aborted) return;
      const entries = [...states.values()];
      let state = "ready";
      if (
        !providers.length ||
        !paths.length ||
        (entries.length === providers.length &&
          entries.every(({ state }) => state === "unavailable"))
      ) {
        state = "unavailable";
      } else if (
        entries.some(({ state }) => state === "partial") ||
        (entries.some(({ state }) => state === "error") &&
          entries.some(({ state }) => state === "ready"))
      ) {
        state = "partial";
      } else if (
        entries.length === providers.length &&
        entries.some(({ state }) => state === "error") &&
        entries.every(({ state }) => state === "error" || state === "unavailable")
      ) {
        state = "error";
      } else if (entries.some(({ state }) => state === "starting")) {
        state = "starting";
      }
      options.onStatus?.({ state });
    };
    const publish = (provider, symbols) => {
      if (run.signal.aborted || !Array.isArray(symbols)) return;
      const normalized = this.normalizedSymbols(symbols, provider, { workspace: true });
      if (symbols.length && !normalized.length) states.set(provider, { state: "error" });
      results.set(provider, normalized);
      options.onSymbols?.(snapshot());
    };
    try {
      if (!providers.length || !paths.length) {
        status();
        return [];
      }
      await Promise.all(
        providers.map(async (provider) => {
          const result = await this.request(
            provider,
            run.signal,
            (request) => provider.searchWorkspaceSymbols(query, request),
            {
              paths,
              onSymbols: (symbols) => publish(provider, symbols),
              onStatus: (value) => {
                if (run.signal.aborted) return;
                states.set(provider, value);
                status();
              },
            },
          );
          if (run.signal.aborted) return;
          if (result.ok) {
            if (!states.has(provider)) states.set(provider, { state: "ready" });
            publish(provider, result.symbols);
          } else {
            states.set(provider, { state: results.get(provider)?.length ? "partial" : "error" });
          }
          status();
        }),
      );
      return run.signal.aborted ? null : snapshot();
    } finally {
      run.finish();
    }
  }

  async findDefinitions(editor, options = {}) {
    if (this.destroyed || !editor || editor.isDestroyed()) return null;
    const run = this.beginQuery(options.signal, "definition");
    const subscriptions = new CompositeDisposable(
      editor.getBuffer().onDidChangeText(() => run.signal.aborted || this.abortDefinitions(run)),
      editor.onDidChangeGrammar(() => this.abortDefinitions(run)),
      editor.onDidChangePath(() => this.abortDefinitions(run)),
      editor.onDidDestroy(() => this.abortDefinitions(run)),
    );
    try {
      const providers = await this.broker.select("definition", editor, run.signal);
      if (!providers.length) options.onStatus?.({ state: "unavailable" });
      for (const provider of providers) {
        const result = await this.request(provider, run.signal, (request) =>
          provider.getDefinitions(editor, { ...request, range: options.range }),
        );
        if (run.signal.aborted) return null;
        if (!this.broker.providers.definition.includes(provider)) return null;
        if (!result.ok) continue;
        const symbols = this.normalizedSymbols(result.symbols, provider);
        if (result.symbols.length && !symbols.length) continue;
        options.onStatus?.({ state: "ready" });
        return this.uniqueWorkspaceSymbols(symbols);
      }
      if (providers.length) options.onStatus?.({ state: "error" });
      return run.signal.aborted ? null : [];
    } finally {
      subscriptions.dispose();
      run.finish();
    }
  }

  abortDefinitions(run) {
    run.abort();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const editor of [...this.inflight.keys()]) this.abortInflight(editor);
    this.abortQueries();
    this.editorsSubscription.dispose();
    for (const subscriptions of this.editorSubscriptions.values()) subscriptions.dispose();
    this.editorSubscriptions.clear();
    this.subscriptions.dispose();
    this.broker.destroy();
    this.cache.clear();
    this.stale.clear();
    this.emitter.dispose();
  }

  buildFileSymbolTree(symbols) {
    const roots = [];
    const entries = symbols.map((symbol) => ({ ...symbol, children: [] }));
    const stack = [];
    const latestByName = new Map();

    // File results are ordered by navigation position. A provider can still
    // supply a structural range whose start moves backwards; preserve the old
    // all-pairs semantics for that malformed-but-supported case. The ordinary
    // lexical case below is linear.
    let previousStart = null;
    let previousEnd = null;
    for (let entry of entries) {
      if (entry.range.isEmpty()) continue;
      let startComparison = previousStart?.compare(entry.range.start) ?? -1;
      if (
        startComparison > 0 ||
        (startComparison === 0 && previousEnd.compare(entry.range.end) < 0)
      ) {
        return this.buildFileSymbolTreeByScan(entries);
      }
      previousStart = entry.range.start;
      previousEnd = entry.range.end;
    }

    for (let entry of entries) {
      let parent = null;

      if (!entry.range.isEmpty()) {
        while (stack.length && !stack.at(-1).range.containsRange(entry.range)) stack.pop();

        // Equal ranges are peers. Keep the first copy on the stack: for a
        // later nested symbol it is also the entry selected by the old reverse
        // scan when several providers reported the same enclosing range.
        if (stack.length && stack.at(-1).range.isEqual(entry.range)) {
          parent = stack.at(-2) ?? null;
        } else {
          parent = stack.at(-1) ?? null;
          stack.push(entry);
        }
      }

      // Point-only providers cannot express containment. Their context names
      // the parent, so attach to the latest preceding matching symbol.
      if (!parent && entry.context) parent = latestByName.get(entry.context) ?? null;

      (parent ? parent.children : roots).push(entry);
      latestByName.set(entry.name, entry);
      if (entry.shortName) latestByName.set(entry.shortName, entry);
    }

    return roots;
  }

  buildFileSymbolTreeByScan(entries) {
    const roots = [];

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      let parent = null;

      if (!entry.range.isEmpty()) {
        for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
          const candidate = entries[candidateIndex];
          if (candidate.range.isEmpty() || candidate.range.isEqual(entry.range)) continue;
          if (!candidate.range.containsRange(entry.range)) continue;
          if (!parent || parent.range.containsRange(candidate.range)) parent = candidate;
        }
      }

      if (!parent && entry.context) {
        for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
          const candidate = entries[candidateIndex];
          if (candidate.name === entry.context || candidate.shortName === entry.context) {
            parent = candidate;
            break;
          }
        }
      }

      (parent ? parent.children : roots).push(entry);
    }

    return roots;
  }

  isValidSymbol(symbol) {
    if (typeof symbol?.name !== "string") return false;
    if (!symbol.position && !symbol.range) return false;
    if (symbol.position && !this.isPointCompatible(symbol.position)) return false;
    if (symbol.range && !this.isRangeCompatible(symbol.range)) return false;
    return true;
  }

  // Positions and ranges cross the service boundary in any Point/Range-
  // compatible spelling — `[row, column]` arrays included — so a provider
  // never has to share this window's `Point` class.
  isPointCompatible(value) {
    if (Array.isArray(value)) return typeof value[0] === "number";
    return typeof value?.row === "number";
  }

  isRangeCompatible(value) {
    if (Array.isArray(value))
      return this.isPointCompatible(value[0]) && this.isPointCompatible(value[1]);
    return this.isPointCompatible(value?.start) && this.isPointCompatible(value?.end);
  }

  normalizeSymbol(symbol, provider, pathCache = null) {
    // Every symbol leaves the registry with both a real navigation Point and
    // a real structural Range. Point-only providers receive an empty range.
    if (symbol.range) symbol.range = Range.fromObject(symbol.range);
    symbol.position = symbol.position ? Point.fromObject(symbol.position) : symbol.range.start;
    symbol.range ??= new Range(symbol.position, symbol.position);
    // We enforce these so that (a) we can show a human-readable name of the
    // provider for each symbol (if the user opts into it), and (b) we can
    // selectively clear cached results for certain providers without
    // affecting others.
    symbol.providerName ??= provider.name;
    symbol.providerId ??= provider.packageName;

    if (symbol.path) {
      let parts = pathCache?.get(symbol.path);
      if (!parts) {
        let parsed = Path.parse(symbol.path);
        parts = { directory: `${parsed.dir}${Path.sep}`, file: parsed.base };
        pathCache?.set(symbol.path, parts);
      }
      symbol.directory = parts.directory;
      symbol.file = parts.file;
    }
    symbol.name = symbol.name.replace(/[\n\r\t]/g, " ");
  }

  addSymbols(allSymbols, newSymbols, provider, pathCache = null) {
    for (let symbol of newSymbols) {
      if (!this.isValidSymbol(symbol)) {
        console.warn("Invalid symbol:", symbol);
        continue;
      }

      this.normalizeSymbol(symbol, provider, pathCache);
      allSymbols.push(symbol);
    }
  }
};
