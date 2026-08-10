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

    // Editor → sorted symbol list. Only non-empty results are cached.
    this.cache = new Map();
    // Cached results can be partially invalidated. If a provider wants to
    // clear only its own cached results, keep track of it so that we know to
    // ask it for new symbols in spite of the presence of other results in the
    // cache.
    this.invalidatedProviders = new Map();
    // Editor → { promise, controller } for the fetch currently under way.
    this.inflight = new Map();
    this.watchedEditors = new WeakSet();

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
      if (this.watchedEditors.has(editor)) return;

      const invalidate = () => this.invalidateEditor(editor);
      const buffer = editor.getBuffer();

      // All the core actions that can invalidate an editor's symbols.
      const editorSubscriptions = new CompositeDisposable(
        editor.onDidChangeGrammar(invalidate),
        editor.onDidSave(invalidate),
        editor.onDidChangePath(invalidate),
        buffer.onDidReload(invalidate),
        buffer.onDidDestroy(invalidate),
        buffer.onDidStopChanging(invalidate),
      );

      editorSubscriptions.add(
        editor.onDidDestroy(() => {
          this.watchedEditors.delete(editor);
          editorSubscriptions.dispose();
        }),
      );

      this.watchedEditors.add(editor);
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (let editor of [...this.inflight.keys()]) {
      this.abortInflight(editor);
    }
    this.cache.clear();
    this.invalidatedProviders.clear();
    this.editorsSubscription.dispose();
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
      this.removeProviderFromCache(someEditor, provider);
    }
    this.emitter.emit("did-invalidate-file-symbols", {
      editor,
      provider: this.describeProvider(provider),
    });
  }

  removeProviderFromCache(editor, provider) {
    let results = this.cache.get(editor);
    if (!results || results.length === 0) return;

    results = results.filter((sym) => sym.providerId !== provider.packageName);
    if (results.length === 0) {
      // No other providers had cached any symbols, so we can do the simple
      // thing here.
      this.cache.delete(editor);
      this.invalidatedProviders.delete(editor);
      return;
    }
    // There's at least one remaining cached symbol. When we serve this cache
    // entry, we need a way of knowing whether it is comprehensive. So we'll
    // add this provider to a list of providers that will need re-querying.
    this.cache.set(editor, results);
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
    if (this.destroyed) return Promise.resolve(null);

    let cached = this.peekFileSymbols(editor);
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

    let providers = await this.broker.select(meta);
    if (signal.aborted) return null;

    // If the last cache result was only partially invalidated, requery only
    // the providers whose portions went stale, seeding the run with the
    // symbols that survived.
    let onlyProviders = this.invalidatedProviders.get(editor);
    let existing = this.cache.get(editor) ?? null;
    if (onlyProviders?.size) {
      providers = providers.filter((p) => onlyProviders.has(p));
    }

    if (providers.length === 0) return existing;

    let symbols = await this.gatherSymbols(providers, signal, meta, {
      symbols: existing ? [...existing] : [],
      timeoutMs,
      listController,
    });
    if (signal.aborted) return null;

    this.invalidatedProviders.delete(editor);
    symbols.sort((a, b) => a.position.compare(b.position));
    if (symbols.length > 0) {
      // Only cache non-empty results.
      this.cache.set(editor, symbols);
    }
    return symbols;
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
    if (symbol.position) return this.isPointCompatible(symbol.position);
    return this.isRangeCompatible(symbol.range);
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

  normalizeSymbol(symbol, provider) {
    // Every symbol leaves the registry with a `position` that is a real
    // `Point` (and a real `Range` when it has a range), so no consumer has to
    // re-derive one or handle the compatible spellings.
    if (symbol.range) symbol.range = Range.fromObject(symbol.range);
    symbol.position = symbol.position
      ? Point.fromObject(symbol.position)
      : symbol.range.start;
    // We enforce these so that (a) we can show a human-readable name of the
    // provider for each symbol (if the user opts into it), and (b) we can
    // selectively clear cached results for certain providers without
    // affecting others.
    symbol.providerName ??= provider.name;
    symbol.providerId ??= provider.packageName;
    if (symbol.path) {
      let parts = Path.parse(symbol.path);
      symbol.directory = `${parts.dir}${Path.sep}`;
      symbol.file = parts.base;
    }
    symbol.name = symbol.name.replace(/[\n\r\t]/, " ");
  }

  addSymbols(allSymbols, newSymbols, provider) {
    for (let symbol of newSymbols) {
      if (!this.isValidSymbol(symbol)) {
        console.warn("Invalid symbol:", symbol);
        continue;
      }

      this.normalizeSymbol(symbol, provider);
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
      this.addSymbols(symbols, newSymbols, provider);
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
