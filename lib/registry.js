const { CompositeDisposable, Emitter, Point, Range } = require("lumine");
const Path = require("path");

const Config = require("./config");
const ProviderBroker = require("./provider-broker");
const { isIterable, timeout } = require("./util");

// A stand-in handed to exclusive providers when no list UI initiated the
// fetch, so a provider that sets loading or error messages unconditionally
// never has to care who asked.
const NO_OP_LIST_CONTROLLER = Object.freeze({
  set() {},
  clear() {},
});

/**
 * The hub's aggregation point: owns the per-editor file-symbol cache, its
 * invalidation, and the fetch pipeline shared by every consumer — the
 * package's own pickers and anything consuming the `symbol.registry` service.
 *
 * One fetch serves every caller: concurrent `getFileSymbols` calls for the
 * same editor share one in-flight run, and a completed run is cached until
 * something invalidates it.
 */
module.exports = class Registry {
  constructor() {
    this.broker = new ProviderBroker();
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.destroyed = false;

    // Editor → { flat, tree }. Both views come from the same provider run,
    // but the tree is assembled lazily so flat consumers do not pay for it.
    this.cache = new Map();
    // Cached results can be partially invalidated. If a provider wants to
    // clear only its own cached results, keep track of it so that we know to
    // ask it for new symbols in spite of the presence of other results in the
    // cache.
    this.invalidatedProviders = new Map();
    // Internal provider identity is finer-grained than the public providerId,
    // which intentionally names the package. Two providers from one package
    // must still be invalidated independently.
    this.symbolProviders = new WeakMap();
    // Editor → { promise, controller } for the fetch currently under way.
    this.inflight = new Map();
    // Keep the subscriptions themselves, not just a record that an editor was
    // seen. That lets both sides of the lifecycle release the other promptly.
    this.editorSubscriptions = new Map();

    this.subscriptions.add(
      // Anything that changes the provider pool makes every cache entry
      // non-comprehensive for that provider.
      this.broker.onDidAddProvider((provider) => this.invalidateProvider(provider)),
      this.broker.onDidRemoveProvider((provider) => this.invalidateProvider(provider)),
      this.broker.onShouldClearCache((bundle = {}) => {
        let { provider = null, editor = null } = bundle;
        this.invalidateProvider(provider, editor);
      }),
      Config.onDidChange(() => this.invalidateAll()),
    );

    this.editorsSubscription = lumine.workspace.observeTextEditors((editor) => {
      if (this.editorSubscriptions.has(editor)) return;

      const invalidate = () => this.invalidateEditor(editor);
      const buffer = editor.getBuffer();

      // All the core actions that can invalidate an editor's symbols.
      const editorSubscriptions = new CompositeDisposable(
        editor.onDidChangeGrammar(invalidate),
        editor.onDidSave(invalidate),
        editor.onDidChangePath(invalidate),
        buffer.onDidReload(invalidate),
        buffer.onDidStopChanging(invalidate),
      );

      editorSubscriptions.add(
        editor.onDidDestroy(() => this.forgetEditor(editor)),
        buffer.onDidDestroy(() => {
          this.forgetEditor(editor);
          this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
        }),
      );

      this.editorSubscriptions.set(editor, editorSubscriptions);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (let editor of [...this.inflight.keys()]) {
      this.abortInflight(editor);
    }
    this.editorsSubscription.dispose();
    for (let subscriptions of this.editorSubscriptions.values()) subscriptions.dispose();
    this.editorSubscriptions.clear();
    this.cache.clear();
    this.invalidatedProviders.clear();
    this.subscriptions.dispose();
    this.broker.destroy();
    this.emitter.dispose();
  }

  // Provider registration — the `symbol.provider` side of the hub. Not
  // exposed on the `symbol.registry` service: registration goes through
  // ServiceHub so that a registry consumer cannot smuggle providers in.

  addProviders(...providers) {
    this.broker.add(...providers);
  }

  removeProviders(...providers) {
    this.broker.remove(...providers);
  }

  hasProviders() {
    return this.broker.providers.length > 0;
  }

  providerDescriptors() {
    return this.broker.providers.map((provider) => this.describeProvider(provider));
  }

  describeProvider(provider) {
    if (!provider) return null;
    return {
      name: provider.name,
      packageName: provider.packageName,
      isExclusive: provider.isExclusive ?? false,
    };
  }

  onDidChangeProviders(callback) {
    return new CompositeDisposable(
      this.broker.onDidAddProvider(() => callback()),
      this.broker.onDidRemoveProvider(() => callback()),
    );
  }

  onDidInvalidateFileSymbols(callback) {
    return this.emitter.on("did-invalidate-file-symbols", callback);
  }

  // Invalidation. Every path aborts the affected in-flight runs — their
  // results would describe a state that no longer exists — and then announces
  // itself, so a consumer rendering symbols knows to ask again.

  forgetEditor(editor) {
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.invalidatedProviders.delete(editor);
    let subscriptions = this.editorSubscriptions.get(editor);
    this.editorSubscriptions.delete(editor);
    subscriptions?.dispose();
  }

  invalidateEditor(editor) {
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.invalidatedProviders.delete(editor);
    this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
  }

  invalidateAll() {
    for (let editor of [...this.inflight.keys()]) {
      this.abortInflight(editor);
    }
    this.cache.clear();
    this.invalidatedProviders.clear();
    this.emitter.emit("did-invalidate-file-symbols", { editor: null, provider: null });
  }

  invalidateProvider(provider, editor = null) {
    if (!provider) {
      editor ? this.invalidateEditor(editor) : this.invalidateAll();
      return;
    }
    let editors = editor ? [editor] : new Set([...this.cache.keys(), ...this.inflight.keys()]);
    for (let someEditor of editors) {
      this.abortInflight(someEditor);
      if (provider.isExclusive) {
        // The exclusive provider is a winner, not an additive slice. Once a
        // contender changes, retaining the old winner could merge two
        // exclusives or hide the fallback that should replace a removed one.
        this.cache.delete(someEditor);
        this.invalidatedProviders.delete(someEditor);
      } else {
        this.removeProviderFromCache(someEditor, provider);
      }
    }
    this.emitter.emit("did-invalidate-file-symbols", {
      editor,
      provider: this.describeProvider(provider),
    });
  }

  removeProviderFromCache(editor, provider) {
    let bundle = this.cache.get(editor);
    if (!bundle) return;

    if (!bundle.unavailable) {
      let results = bundle.flat.filter((symbol) => this.symbolProviders.get(symbol) !== provider);
      this.cache.set(editor, this.createFileBundle(results));
    }
    // Remember that this provider's portion is missing even when the surviving
    // list is empty. Empty results are cached now, and a provider arriving late
    // must still be queried on the next request.
    let providers = this.invalidatedProviders.get(editor);
    if (!providers) {
      providers = new Set();
      this.invalidatedProviders.set(editor, providers);
    }
    providers.add(provider);
  }

  abortInflight(editor) {
    let entry = this.inflight.get(editor);
    if (!entry) return;
    this.inflight.delete(editor);
    entry.controller.abort();
  }

  // The cache, read without fetching. Non-null only when the entry is
  // complete — no provider's portion pending re-query.
  peekFileSymbols(editor) {
    let cached = this.peekFileBundle(editor);
    return cached && !cached.unavailable ? cached.flat : null;
  }

  peekFileSymbolTree(editor) {
    let cached = this.peekFileBundle(editor);
    return cached && !cached.unavailable ? this.treeForBundle(cached) : null;
  }

  peekFileBundle(editor) {
    let cached = this.cache.get(editor);
    if (!cached) return null;
    if (this.invalidatedProviders.get(editor)?.size) return null;
    return cached;
  }

  /**
   * Resolve the sorted symbol list for an editor, from cache when it is
   * complete, sharing an in-flight run when one exists, fetching otherwise.
   *
   * Resolves `[]` when the selected providers found nothing, or `null` when
   * no provider could serve the request or the run was superseded by an
   * invalidation — on `null`, keep what you have or wait for the next
   * invalidation event.
   */
  getFileSymbols(editor, options = {}) {
    return this.getFileBundle(editor, options).then((bundle) =>
      bundle && !bundle.unavailable ? bundle.flat : null,
    );
  }

  getFileSymbolTree(editor, options = {}) {
    return this.getFileBundle(editor, options).then((bundle) =>
      bundle && !bundle.unavailable ? this.treeForBundle(bundle) : null,
    );
  }

  getFileBundle(editor, options = {}) {
    if (this.destroyed) return Promise.resolve(null);

    let cached = this.peekFileBundle(editor);
    if (cached) return Promise.resolve(cached);

    let inflight = this.inflight.get(editor);
    if (inflight) return inflight.promise;

    let controller = new AbortController();
    let entry = { controller, promise: null };
    entry.promise = this.runFileFetch(editor, controller.signal, options).finally(() => {
      if (this.inflight.get(editor) === entry) this.inflight.delete(editor);
    });
    this.inflight.set(editor, entry);
    return entry.promise;
  }

  async runFileFetch(editor, signal, { listController = null } = {}) {
    let timeoutMs = Config.get("providerTimeout");
    let meta = { type: "file", editor, timeoutMs };

    // If the last cache result was only partially invalidated, requery only
    // the providers whose portions went stale, seeding the run with the
    // symbols that survived.
    let onlyProviders = this.invalidatedProviders.get(editor);
    let existingBundle = this.cache.get(editor) ?? null;
    let existing = existingBundle?.flat ?? null;
    let providers;
    if (onlyProviders?.size && [...onlyProviders].every((provider) => !provider.isExclusive)) {
      // A supplemental provider cannot change which exclusive provider wins,
      // so selecting the whole pool again only repeats unrelated capability
      // checks. The broker also drops candidates that have since been removed.
      providers = await this.broker.select(meta, { candidates: [...onlyProviders] });
    } else {
      providers = await this.broker.select(meta);
    }
    if (signal.aborted) return null;

    if (onlyProviders?.size && providers.length > 0) {
      providers = providers.filter((p) => onlyProviders.has(p));
    }

    if (providers.length === 0) {
      this.invalidatedProviders.delete(editor);
      if (existingBundle) return existingBundle;
      let unavailable = { flat: [], tree: null, unavailable: true };
      this.cache.set(editor, unavailable);
      return unavailable;
    }

    let symbols = await this.gatherSymbols(providers, signal, meta, {
      symbols: existing ? [...existing] : [],
      timeoutMs,
      listController,
    });
    if (signal.aborted) return null;

    this.invalidatedProviders.delete(editor);
    symbols.sort((a, b) => a.position.compare(b.position));
    let bundle = this.createFileBundle(symbols);
    // An empty answer is still a complete answer. Caching it prevents every
    // consumer from asking the same provider again for an empty document.
    this.cache.set(editor, bundle);
    return bundle;
  }

  createFileBundle(symbols) {
    return { flat: symbols, tree: null };
  }

  treeForBundle(bundle) {
    bundle.tree ??= this.buildFileSymbolTree(bundle.flat);
    return bundle.tree;
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

  /**
   * Ask every capable provider for project-wide symbols matching a query.
   * Uncached; exclusivity is not enforced, because the user expects results
   * from all files in the project regardless of language. `options.onSymbols`
   * streams partial results as providers answer; `options.signal` is the
   * caller's — abort it when the query changes.
   */
  async searchProject(editor, query = "", options = {}) {
    if (this.destroyed) return null;
    let meta = { type: "project", editor, query };
    let signal = options.signal ?? new AbortController().signal;

    let providers = await this.broker.select(meta, { enforceExclusivity: false });
    if (providers.length === 0) {
      console.warn("symbol: no providers can search this project");
      return null;
    }

    let symbols = await this.gatherSymbols(providers, signal, meta, {
      onSymbols: options.onSymbols,
      timeoutMs: Config.get("providerTimeout"),
      listController: options.listController,
    });
    if (signal.aborted) return null;
    return symbols;
  }

  /**
   * Ask for the declaration sites of the symbol under `options.range`, or of
   * whatever the providers infer from the cursor when no range is given.
   * Uncached. Resolves `[]` when no provider is capable.
   */
  async findDeclarations(editor, options = {}) {
    if (this.destroyed) return null;
    let meta = {
      type: "project-find",
      editor,
      paths: lumine.project.getPaths(),
    };
    if (options.range) {
      meta.range = options.range;
      meta.query = editor.getTextInBufferRange(options.range);
    }
    let signal = options.signal ?? new AbortController().signal;

    let providers = await this.broker.select(meta);
    if (providers.length === 0) return [];

    let symbols = await this.gatherSymbols(providers, signal, meta, {
      timeoutMs: Config.get("providerTimeout"),
      listController: options.listController,
    });
    if (signal.aborted) return null;
    return symbols;
  }

  // The fetch pipeline.

  isValidSymbol(symbol) {
    if (typeof symbol.name !== "string") return false;
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
    if (Array.isArray(value)) return this.isPointCompatible(value[0]);
    return this.isPointCompatible(value?.start);
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
    this.symbolProviders.set(symbol, provider);
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
    symbol.name = symbol.name.replace(/[\n\r\t]/, " ");
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

  /**
   * Ask a single provider for symbols.
   *
   * @param   {Object} provider The provider to ask.
   * @param   {AbortSignal} signal The signal for the task as a whole.
   * @param   {Object} meta The task descriptor to hand to the provider.
   * @param   {Number} timeoutMs How long the provider has before its own
   *   signal aborts.
   * @param   {Object} listController The list controller to hand to an
   *   exclusive provider.
   * @returns {Object} An object whose `symbols` property is whatever the
   *   provider returned — a list, or a promise of one — and whose `signal`
   *   property is the signal governing that particular provider. Callers need
   *   the latter to tell a provider that failed them from one they gave up on:
   *   returning nothing once that signal aborts is the documented contract
   *   being honored, not a provider misbehaving.
   */
  getSymbolsFromProvider(provider, signal, meta, timeoutMs, listController) {
    let controller = new AbortController();

    // If the task as a whole is cancelled, propagate that cancellation to
    // this provider's AbortController.
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    // Cancel this job automatically if it times out.
    let timer = setTimeout(() => controller.abort(), timeoutMs);

    // The exclusive provider is the only one that gets an instance of
    // `ListController` so that it can set UI messages.
    let args = [{ signal: controller.signal, ...meta }];
    if (provider.isExclusive) args.push(listController ?? NO_OP_LIST_CONTROLLER);

    // Stop the clock the moment the provider answers. Left running, it would
    // tell a provider its work was cancelled long after it had delivered.
    let stopClock = () => clearTimeout(timer);

    let symbols;
    try {
      symbols = provider.getSymbols(...args);
    } catch (error) {
      stopClock();
      throw error;
    }

    if (symbols?.then) {
      symbols = symbols.then(
        (value) => {
          stopClock();
          return value;
        },
        (error) => {
          stopClock();
          throw error;
        },
      );
    } else {
      stopClock();
    }

    return { symbols, signal: controller.signal };
  }

  /**
   * Ask each of the given providers for symbols and gather what comes back.
   *
   * Settles when every provider has answered or when they collectively run
   * past the timeout budget, whichever happens first.
   *
   * @param   {Array} providers The providers to ask.
   * @param   {AbortSignal} signal The signal for the task as a whole.
   * @param   {Object} meta The task descriptor to hand to each provider.
   * @param   {Object} options Options.
   * @param   {Array} options.symbols The list to gather symbols into.
   *   Optional; defaults to a new empty list. Pass one to seed the results
   *   with symbols that are already known.
   * @param   {Function} options.onSymbols Called with the gathered symbols
   *   each time a provider adds to them, for a list that fills in as it loads.
   *   Optional.
   * @param   {Number} options.timeoutMs The budget for the run as a whole and
   *   for each provider individually.
   * @param   {Object} options.listController Handed to the exclusive
   *   provider so it can set UI messages. Optional.
   * @returns {Promise<Array>} The gathered symbols.
   */
  async gatherSymbols(
    providers,
    signal,
    meta,
    { symbols = [], onSymbols = null, timeoutMs = 2000, listController = null } = {},
  ) {
    // Once we stop waiting we stop listening. Every provider holds a signal
    // that aborts on this same budget, so anything still arriving afterwards
    // comes from a provider that ignored it — and taking that would mean the
    // provider honoring the contract gets nothing shown while the one flouting
    // it gets a late render. The write has nowhere good to go regardless: by
    // then the caller has sorted these symbols, rendered them, and cached the
    // list, so a straggler appears out of order or not until the next toggle.
    let closed = false;
    let pathCache = new Map();

    let error = (err, provider, providerSignal) => {
      // A provider we cancelled — because it ran past `providerTimeout`, or
      // because the task was withdrawn — owes us nothing. Abandoning its
      // work is precisely what we asked it to do, so blaming it for the empty
      // hands it comes back with would be reporting our own decision as its
      // fault. Only a provider that failed us on its own terms is worth a word.
      if (providerSignal?.aborted || signal.aborted) return;
      let message = typeof err === "string" ? err : err.message;
      console.error(`Error in retrieving symbols from provider ${provider.name}: ${message}`);
    };

    let done = (newSymbols, provider, providerSignal) => {
      if (closed || signal.aborted) return;
      if (!isIterable(newSymbols)) {
        error(`Provider did not return a list of symbols`, provider, providerSignal);
        return;
      }
      this.addSymbols(symbols, newSymbols, provider, pathCache);
      onSymbols?.(symbols);
    };

    let tasks = [];
    for (let provider of providers) {
      let providerSignal;
      try {
        let result = this.getSymbolsFromProvider(provider, signal, meta, timeoutMs, listController);
        providerSignal = result.signal;
        if (result.symbols?.then) {
          // The provider went async, so we have something to wait for.
          tasks.push(
            result.symbols
              .then((value) => done(value, provider, providerSignal))
              .catch((err) => error(err, provider, providerSignal)),
          );
        } else {
          done(result.symbols, provider, providerSignal);
        }
      } catch (err) {
        error(err, provider, providerSignal);
      }
    }

    if (tasks.length > 0) {
      await Promise.race([Promise.allSettled(tasks), timeout(timeoutMs)]);
    }
    closed = true;

    return symbols;
  }
};
