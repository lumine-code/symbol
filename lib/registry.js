const { CompositeDisposable, Emitter, Point, Range } = require("lumine");
const Path = require("path");
const trackSymbolCoordinates = require("./track-symbol-coordinates");
const DocumentWork = require("./document-work");

const Config = {
  activate() {
    if (this.activated) return;
    this.emitter ??= new Emitter();
    this.subscriptions = new CompositeDisposable();

    this.subscriptions.add(
      lumine.config.onDidChange("symbol", (config) => {
        this.emitter.emit("did-change-config", config);
      }),
    );
    this.activated = true;
  },

  deactivate() {
    this.activated = false;
    this.subscriptions?.dispose();
  },

  getForEditor(editor, key) {
    let grammar = editor.getGrammar();
    return lumine.config.get(`symbol.${key}`, { scope: [grammar?.scopeName] });
  },

  get(key) {
    return lumine.config.get(`symbol.${key}`);
  },

  set(key, value) {
    return lumine.config.set(`symbol.${key}`, value);
  },

  observe(key, callback) {
    return lumine.config.observe(`symbol.${key}`, callback);
  },

  onDidChange(callback) {
    // The registry subscribes at construction, which may precede `activate`
    // in tests; the emitter is shared either way.
    this.emitter ??= new Emitter();
    return this.emitter.on("did-change-config", callback);
  },
};

const METHODS = {
  document: ["getDocumentSymbolSources", "getDocumentSymbols"],
  workspace: ["searchWorkspaceSymbols"],
  definition: ["canProvideDefinitions", "getDefinitions"],
};
const CAPABILITY_TIMEOUT = 500;

class ProviderBroker {
  constructor() {
    this.providers = { document: [], workspace: [], definition: [] };
    this.subscriptions = { document: new Map(), workspace: new Map(), definition: new Map() };
    this.emitter = new Emitter();
    this.destroyed = false;
  }

  add(role, ...providers) {
    if (this.destroyed) return;
    for (const provider of providers) {
      const valid =
        typeof provider?.name === "string" &&
        typeof provider?.packageName === "string" &&
        METHODS[role]?.every((method) => typeof provider[method] === "function");
      if (!valid) {
        console.warn("symbol: invalid " + role + " provider", provider);
        continue;
      }
      if (this.providers[role].includes(provider)) continue;
      this.providers[role].push(provider);
      if (role === "document" && provider.onDidInvalidateDocumentSymbols) {
        this.subscriptions[role].set(
          provider,
          provider.onDidInvalidateDocumentSymbols(({ editor = null } = {}) => {
            this.emitter.emit("did-invalidate-document-symbols", { provider, editor });
          }),
        );
      }
      if (role === "workspace" && provider.onDidInvalidateWorkspaceSymbols) {
        this.subscriptions[role].set(
          provider,
          provider.onDidInvalidateWorkspaceSymbols(() => {
            this.emitter.emit("did-invalidate-workspace-symbols");
          }),
        );
      }
      this.emitter.emit("did-change-providers", { role, provider });
    }
  }

  remove(role, ...providers) {
    for (const provider of providers) {
      const index = this.providers[role].indexOf(provider);
      if (index < 0) continue;
      this.providers[role].splice(index, 1);
      this.subscriptions[role].get(provider)?.dispose();
      this.subscriptions[role].delete(provider);
      this.emitter.emit("did-change-providers", { role, provider });
    }
  }

  onDidChangeProviders(callback) {
    return this.emitter.on("did-change-providers", callback);
  }

  onDidInvalidateDocumentSymbols(callback) {
    return this.emitter.on("did-invalidate-document-symbols", callback);
  }

  onDidInvalidateWorkspaceSymbols(callback) {
    return this.emitter.on("did-invalidate-workspace-symbols", callback);
  }

  descriptors() {
    return Object.entries(this.providers).flatMap(([role, providers]) =>
      providers.map(({ name, packageName }) => ({ name, packageName, role })),
    );
  }

  async documentSources(editor, signal) {
    if (this.destroyed || signal?.aborted || !editor) return [];
    const providers = [...this.providers.document];
    const outcomes = await Promise.all(
      providers.map(async (provider) => {
        let timer;
        const controller = new AbortController();
        const requestSignal = signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal;
        let abort;
        try {
          const items = await Promise.race([
            Promise.resolve().then(() =>
              provider.getDocumentSymbolSources(editor, { signal: requestSignal }),
            ),
            new Promise((resolve) => {
              abort = () => resolve([]);
              requestSignal.addEventListener("abort", abort, { once: true });
              timer = setTimeout(() => controller.abort(), CAPABILITY_TIMEOUT);
            }),
          ]);
          if (requestSignal.aborted || !Array.isArray(items)) return [];
          return items.flatMap((source) => {
            if (
              !source ||
              typeof source.id !== "string" ||
              !source.id ||
              typeof source.name !== "string" ||
              !source.name ||
              typeof source.shortLabel !== "string" ||
              !source.shortLabel ||
              !["ready", "starting", "unavailable"].includes(source.state) ||
              !Number.isFinite(source.score) ||
              source.score < 0 ||
              (source.execution != null && !["local", "remote"].includes(source.execution))
            )
              return [];
            return [
              {
                id: source.id,
                name: source.name,
                shortLabel: source.shortLabel,
                score: Math.min(source.score, 1),
                state: source.state,
                execution: source.execution ?? "remote",
                ...(typeof source.message === "string" ? { message: source.message } : {}),
                packageName: provider.packageName,
                provider,
              },
            ];
          });
        } catch {
          return [];
        } finally {
          clearTimeout(timer);
          requestSignal.removeEventListener("abort", abort);
        }
      }),
    );
    if (this.destroyed || signal?.aborted) return [];
    const preferred = Config.getForEditor(editor, "preferCertainProviders") ?? [];
    const rank = (source) => {
      const index = preferred.findIndex((name) =>
        [source.id, source.name, source.packageName, source.provider.name].includes(name),
      );
      return source.score + (index < 0 ? 0 : preferred.length - index);
    };
    const seen = new Set();
    return outcomes
      .flat()
      .filter((source) => this.providers.document.includes(source.provider))
      .filter((source) => {
        if (seen.has(source.id)) return false;
        seen.add(source.id);
        return true;
      })
      .sort((left, right) => rank(right) - rank(left));
  }

  async select(role, editor, signal) {
    if (this.destroyed || signal?.aborted || !editor) return [];
    const providers = [...this.providers[role]];
    const method = METHODS[role][0];
    const preferred = Config.getForEditor(editor, "preferCertainProviders") ?? [];
    const outcomes = await Promise.all(
      providers.map(async (provider, index) => {
        let timer;
        let abort;
        try {
          const score = await Promise.race([
            Promise.resolve().then(() => provider[method](editor)),
            new Promise((resolve) => {
              timer = setTimeout(resolve, CAPABILITY_TIMEOUT, 0);
              abort = () => resolve(0);
              signal?.addEventListener("abort", abort, { once: true });
            }),
          ]);
          if (!(score > 0) || !Number.isFinite(Number(score))) return null;
          const preference = preferred.findIndex(
            (name) => name === provider.packageName || name === provider.name,
          );
          return {
            provider,
            index,
            score:
              Math.min(Number(score), 1) + (preference < 0 ? 0 : preferred.length - preference),
          };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      }),
    );
    if (this.destroyed || signal?.aborted) return [];
    return outcomes
      .filter((entry) => entry && this.providers[role].includes(entry.provider))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map(({ provider }) => provider);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const subscriptions of Object.values(this.subscriptions)) {
      new CompositeDisposable(...subscriptions.values()).dispose();
      subscriptions.clear();
    }
    for (const providers of Object.values(this.providers)) providers.length = 0;
    // Providers belong to their packages, independently of this consumer.
    this.emitter.dispose();
  }
}

const fileChoicesFromStorage = (entries) =>
  new Map(
    (Array.isArray(entries) ? entries : []).filter(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        (entry[1] === null || (typeof entry[1] === "string" && entry[1] && entry[1] !== "auto")),
    ),
  );

module.exports = class Registry {
  constructor(storage) {
    this.workspaceState = storage;
    this.broker = new ProviderBroker();
    this.emitter = new Emitter();
    this.cache = new Map();
    this.trackedBundles = new Map();
    this.sourceCaches = new Map();
    this.sourceStates = new Map();
    this.sourceDescriptors = new Map();
    this.sourceChoices = new Map();
    this.fileChoices = fileChoicesFromStorage(storage.get("documentSources", []));
    this.pendingChoices = new Map();
    this.editorSourceKeys = new Map();
    this.sourceRevisions = new Map();
    this.sourceChoiceSubscriptions = new Map();
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
      Config.onDidChange(({ oldValue, newValue }) => {
        const symbolsConfig = (value) => {
          const { documentSource, showStatusBarItem, ...rest } = value ?? {};
          void documentSource;
          void showStatusBarItem;
          return JSON.stringify(rest);
        };
        if (symbolsConfig(oldValue) !== symbolsConfig(newValue)) this.invalidateAll();
      }),
      lumine.project.onWillChangeState(() => this.abortQueries()),
      lumine.project.onDidChangePaths(() => {
        this.abortQueries();
        this.emitter.emit("did-invalidate-workspace-symbols");
      }),
    );
    this.subscriptions.add(
      storage.observe("documentSources", (entries, { scopeChanged }) => {
        if (this.destroyed) return;
        if (scopeChanged) this.pendingChoices = new Map();
        this.applyStoredChoices(entries);
      }),
    );
    this.editorsSubscription = lumine.workspace.observeTextEditors((editor) =>
      this.trackEditor(editor),
    );
  }

  trackEditor(editor) {
    if (this.editorSubscriptions.has(editor)) return;
    this.sourceRevisions.set(editor, 0);
    const buffer = editor.getBuffer();
    const invalidate = () => this.invalidateEditor(editor);
    this.bindSourceChoice(editor);
    this.editorSubscriptions.set(
      editor,
      new CompositeDisposable(
        editor.onDidChangeGrammar(() => {
          this.trackedBundles.delete(editor);
          this.bindSourceChoice(editor);
          invalidate();
        }),
        editor.onDidSave(invalidate),
        editor.onDidChangePath(invalidate),
        buffer.onDidReload(invalidate),
        buffer.onDidApplyChanges(({ changes }) => {
          const bundle = this.trackedBundles.get(editor);
          if (bundle) trackSymbolCoordinates(bundle.flat, changes);
        }),
        buffer.onDidChangeText(() => {
          this.bumpSourceRevision(editor);
          this.stale.add(editor);
          this.sourceCaches.delete(editor);
          this.abortInflight(editor);
          this.setSourceState(editor, { source: null, status: "idle" });
        }),
        buffer.onDidStopChanging(invalidate),
        editor.onDidDestroy(() => this.forgetEditor(editor)),
        buffer.onDidDestroy(() => {
          this.forgetEditor(editor);
          this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
        }),
      ),
    );
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

  onDidChangeDocumentSource(callback) {
    return this.emitter.on("did-change-document-source", callback);
  }

  bumpSourceRevision(editor) {
    this.sourceRevisions.set(editor, (this.sourceRevisions.get(editor) ?? 0) + 1);
  }

  choiceFor(editor) {
    const key = this.fileKeyFor(editor);
    if (this.fileChoices.has(key)) return this.fileChoices.get(key);
    const choice = Config.getForEditor(editor, "documentSource");
    return typeof choice === "string" && choice && choice !== "auto" ? choice : null;
  }

  fileKeyFor(editor) {
    const uri = editor.getURI?.() || editor.getPath?.();
    const key = uri ? `uri:${uri}` : `buffer:${editor.getBuffer().getId()}`;
    const previous = this.editorSourceKeys.get(editor);
    if (
      previous &&
      previous !== key &&
      this.fileChoices.has(previous) &&
      !this.fileChoices.has(key)
    ) {
      const choice = this.fileChoices.get(previous);
      this.fileChoices.set(key, choice);
      this.saveSourceChoice(key, choice, { onlyIfMissing: true });
    }
    this.editorSourceKeys.set(editor, key);
    return key;
  }

  choiceScopeFor(editor) {
    return this.fileChoices.has(this.fileKeyFor(editor)) ? "file" : "grammar";
  }

  bindSourceChoice(editor) {
    this.sourceChoiceSubscriptions.get(editor)?.dispose();
    this.sourceChoices.set(editor, {
      sourceId: this.choiceFor(editor),
      scope: this.choiceScopeFor(editor),
    });
    this.sourceChoiceSubscriptions.set(
      editor,
      lumine.config.onDidChange(
        "symbol.documentSource",
        { scope: [editor.getGrammar()?.scopeName] },
        () => this.applySourceChoice(editor),
      ),
    );
  }

  applySourceChoice(editor) {
    const choice = this.choiceFor(editor);
    const scope = this.choiceScopeFor(editor);
    const previous = this.sourceChoices.get(editor);
    if (choice === previous?.sourceId && scope === previous?.scope) return;
    this.bumpSourceRevision(editor);
    this.sourceChoices.set(editor, { sourceId: choice, scope });
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.trackedBundles.delete(editor);
    this.stale.delete(editor);
    const source = this.sourceDescriptors.get(editor)?.get(choice) ?? null;
    this.setSourceState(editor, { source, status: "idle" });
    this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
  }

  applyStoredChoices(entries) {
    this.fileChoices = fileChoicesFromStorage(entries);
    for (const [key, { sourceId, scope }] of this.pendingChoices) {
      if (scope === "file") this.fileChoices.set(key, sourceId);
      else this.fileChoices.delete(key);
    }
    for (const editor of this.editorSubscriptions.keys()) this.applySourceChoice(editor);
  }

  saveSourceChoice(key, sourceId, { scope = "file", onlyIfMissing = false } = {}) {
    const pending = this.pendingChoices;
    const choice = { sourceId, scope };
    pending.set(key, choice);
    const saving = this.workspaceState.mutate("documentSources", (entries) => {
      const choices = fileChoicesFromStorage(entries);
      if (scope === "file") {
        if (!onlyIfMissing || !choices.has(key)) choices.set(key, sourceId);
      } else choices.delete(key);
      return [...choices];
    });
    const settled = () => {
      if (this.destroyed || this.pendingChoices !== pending || pending.get(key) !== choice) return;
      pending.delete(key);
      this.applyStoredChoices(this.workspaceState.get("documentSources", []));
    };
    saving.then(settled, (error) => {
      settled();
      lumine.notifications.addError("Unable to save symbol source", { detail: error.message });
    });
    return saving;
  }

  setDocumentSource(editor, sourceId, { scope = "file" } = {}) {
    if (this.destroyed || !editor || editor.isDestroyed()) return;
    this.trackEditor(editor);
    if (sourceId !== null && (typeof sourceId !== "string" || !sourceId || sourceId === "auto"))
      throw new TypeError("Choose a document source ID or null for Auto");
    if (!["file", "grammar"].includes(scope)) throw new TypeError("Choose file or grammar scope");
    const key = this.fileKeyFor(editor);
    const saving = this.saveSourceChoice(key, sourceId, { scope });
    if (scope === "file") this.fileChoices.set(key, sourceId);
    else {
      // Saving the picker choice for the grammar also applies it to this
      // file; overrides belonging to other files keep their own choices.
      this.fileChoices.delete(key);
      const scopeName = editor.getGrammar()?.scopeName;
      lumine.config.set(
        "symbol.documentSource",
        sourceId ?? "auto",
        scopeName ? { scopeSelector: `.${scopeName}` } : {},
      );
    }
    // Config dispatches scoped changes synchronously. This also covers an
    // editor supplied before workspace observation has registered it.
    for (const candidate of this.editorSubscriptions.keys()) this.applySourceChoice(candidate);
    this.applySourceChoice(editor);
    return saving;
  }

  getDocumentSourceState(editor) {
    const sourceId = this.choiceFor(editor);
    return (
      this.sourceStates.get(editor) ?? {
        mode: sourceId === null ? "auto" : "manual",
        sourceId,
        scope: this.choiceScopeFor(editor),
        source: null,
        status: "idle",
      }
    );
  }

  setSourceState(editor, update) {
    if (this.destroyed || editor.isDestroyed()) return;
    const sourceId = this.choiceFor(editor);
    const state = {
      mode: sourceId === null ? "auto" : "manual",
      sourceId,
      scope: this.choiceScopeFor(editor),
      source: null,
      status: "idle",
      ...update,
    };
    if (JSON.stringify(this.sourceStates.get(editor)) === JSON.stringify(state)) return;
    this.sourceStates.set(editor, state);
    this.emitter.emit("did-change-document-source", { editor, state });
  }

  rememberSources(editor, sources) {
    const known = this.sourceDescriptors.get(editor) ?? new Map();
    for (const source of sources) {
      const { provider, ...descriptor } = source;
      void provider;
      known.set(source.id, descriptor);
    }
    this.sourceDescriptors.set(editor, known);
    return sources.map(({ provider, ...descriptor }) => {
      void provider;
      return descriptor;
    });
  }

  async listDocumentSources(editor) {
    if (this.destroyed || !editor || editor.isDestroyed()) return [];
    this.trackEditor(editor);
    const revision = this.sourceRevisions.get(editor);
    const sources = await this.broker.documentSources(editor);
    if (this.destroyed || editor.isDestroyed() || this.sourceRevisions.get(editor) !== revision)
      return [];
    const descriptors = this.rememberSources(editor, sources);
    const selected = this.choiceFor(editor);
    if (selected && !descriptors.some((source) => source.id === selected)) {
      const previous = this.sourceDescriptors.get(editor)?.get(selected);
      descriptors.push({
        ...(previous ?? {
          id: selected,
          name: selected,
          shortLabel: "",
          score: 0,
          packageName: "",
        }),
        state: "unavailable",
        message: "This source is unavailable for this document.",
      });
    }
    return descriptors;
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
    this.trackedBundles.delete(editor);
    this.sourceCaches.delete(editor);
    this.sourceStates.delete(editor);
    this.sourceDescriptors.delete(editor);
    this.sourceChoices.delete(editor);
    this.editorSourceKeys.delete(editor);
    this.sourceRevisions.delete(editor);
    this.sourceChoiceSubscriptions.get(editor)?.dispose();
    this.sourceChoiceSubscriptions.delete(editor);
    this.stale.delete(editor);
    this.editorSubscriptions.get(editor)?.dispose();
    this.editorSubscriptions.delete(editor);
  }

  invalidateEditor(editor) {
    this.bumpSourceRevision(editor);
    this.abortInflight(editor);
    this.cache.delete(editor);
    this.sourceCaches.delete(editor);
    this.stale.delete(editor);
    this.setSourceState(editor, { status: "idle" });
    this.emitter.emit("did-invalidate-file-symbols", { editor, provider: null });
  }

  invalidateAll() {
    for (const editor of [...this.inflight.keys()]) this.abortInflight(editor);
    this.cache.clear();
    this.trackedBundles.clear();
    this.sourceCaches.clear();
    this.stale.clear();
    for (const editor of this.editorSubscriptions.keys()) {
      this.bumpSourceRevision(editor);
      this.setSourceState(editor, { status: "idle" });
    }
    this.emitter.emit("did-invalidate-file-symbols", { editor: null, provider: null });
  }

  peekFileBundle(editor) {
    return this.stale.has(editor) ? null : (this.cache.get(editor) ?? null);
  }
  peekFileSymbols(editor) {
    return this.peekFileBundle(editor)?.flat ?? null;
  }
  peekFileSymbolTree(editor) {
    return this.peekFileBundle(editor)?.tree ?? null;
  }
  getFileSymbols(editor) {
    return this.getFileBundle(editor).then((bundle) => bundle?.flat ?? null);
  }
  getFileSymbolTree(editor) {
    return this.getFileBundle(editor).then((bundle) =>
      bundle ? this.treeForBundle(bundle, editor) : null,
    );
  }
  createFileBundle(symbols) {
    return { flat: symbols, tree: null };
  }

  cacheFileBundle(editor, bundle) {
    this.cache.set(editor, bundle);
    // Consumers keep this generation while an edit invalidates its cache and
    // a replacement is pending. Its shared coordinates must follow those edits.
    this.trackedBundles.set(editor, bundle);
  }
  treeForBundle(bundle, editor) {
    const isCurrent = () => !this.destroyed && this.peekFileBundle(editor) === bundle;
    if (!isCurrent()) return null;
    if (bundle.tree) return bundle.tree;
    if (!bundle.treePromise) {
      const pending = this.buildFileSymbolTree(bundle.flat, { isCurrent })
        .then((tree) => {
          if (!isCurrent()) return null;
          bundle.tree = tree;
          return tree;
        })
        .finally(() => {
          // Switching sources retains their unchanged flat snapshots. A
          // cancelled preparation must not permanently poison that cache.
          if (bundle.treePromise === pending) bundle.treePromise = null;
        });
      bundle.treePromise = pending;
    }
    return bundle.treePromise;
  }

  getFileBundle(editor) {
    if (this.destroyed || !editor || editor.isDestroyed()) return Promise.resolve(null);
    this.trackEditor(editor);
    const cached = this.peekFileBundle(editor);
    if (cached) return Promise.resolve(cached);
    const sourceId = this.choiceFor(editor);
    const sourceCached = sourceId && this.sourceCaches.get(editor)?.get(sourceId);
    if (sourceCached) {
      this.cacheFileBundle(editor, sourceCached);
      this.setSourceState(editor, { source: sourceCached.source, status: "ready" });
      return Promise.resolve(sourceCached);
    }
    const inflight = this.inflight.get(editor);
    if (inflight) return inflight.promise;
    const controller = new AbortController();
    const entry = { controller };
    entry.promise = Promise.resolve()
      .then(() => this.runFileFetch(editor, controller.signal))
      .finally(() => {
        if (this.inflight.get(editor) === entry) this.inflight.delete(editor);
      });
    this.inflight.set(editor, entry);
    return entry.promise;
  }

  async runFileFetch(editor, signal) {
    if (signal.aborted || this.destroyed) return null;
    this.setSourceState(editor, { status: "loading" });
    const sources = await this.broker.documentSources(editor, signal);
    if (signal.aborted) return null;
    this.rememberSources(editor, sources);
    const selected = this.choiceFor(editor);
    const candidates = sources.filter(
      (source) =>
        source.state === "ready" &&
        source.score > 0 &&
        (selected === null || source.id === selected),
    );
    if (!candidates.length) {
      const target =
        sources.find((source) => source.id === selected) ??
        (selected ? this.sourceDescriptors.get(editor)?.get(selected) : null);
      const starting = selected
        ? target?.state === "starting"
        : sources.some((source) => source.state === "starting");
      this.setSourceState(editor, {
        source: target ?? null,
        status: starting ? "starting" : "unavailable",
        message: target?.message ?? "No symbol source is available for this document.",
      });
      this.trackedBundles.delete(editor);
      return null;
    }
    for (const candidate of candidates) {
      if (signal.aborted) return null;
      const { provider, ...source } = candidate;
      const cached = this.sourceCaches.get(editor)?.get(source.id);
      if (cached) {
        this.cacheFileBundle(editor, cached);
        this.setSourceState(editor, { source, status: "ready" });
        return cached;
      }
      this.setSourceState(editor, { source, status: "loading" });
      const result = await this.request(
        provider,
        signal,
        (request) => provider.getDocumentSymbols(editor, { ...request, sourceId: source.id }),
        { timeoutMs: source.execution === "local" ? 0 : Config.get("providerTimeout") },
      );
      if (signal.aborted) return null;
      if (!this.broker.providers.document.includes(provider) || !result.ok) continue;
      let symbols = await DocumentWork.run(
        this.normalizeDocumentSymbols(result.symbols, {
          name: source.name,
          packageName: source.id,
        }),
        { signal },
      );
      if (!symbols || signal.aborted) return null;
      if (result.symbols.length && !symbols.length) continue;
      symbols = await DocumentWork.run(DocumentWork.sort(symbols), { signal });
      if (!symbols || signal.aborted) return null;
      const bundle = this.createFileBundle(symbols);
      bundle.source = source;
      this.cacheFileBundle(editor, bundle);
      const cache = this.sourceCaches.get(editor) ?? new Map();
      cache.set(source.id, bundle);
      this.sourceCaches.set(editor, cache);
      this.stale.delete(editor);
      this.setSourceState(editor, { source, status: "ready" });
      return bundle;
    }
    if (!signal.aborted) {
      this.trackedBundles.delete(editor);
      this.setSourceState(editor, {
        source: this.rememberSources(editor, [candidates[0]])[0],
        status: "error",
        message: selected
          ? "The selected source could not return symbols."
          : "Symbol sources could not return symbols.",
      });
    }
    return null;
  }

  // Remote attempts have separate response budgets. Local extraction has no
  // timer, but both follow the parent signal and discard obsolete results.
  async request(provider, parentSignal, run, extra = {}) {
    if (parentSignal.aborted || this.destroyed) return { ok: false };
    const controller = new AbortController();
    const timeoutMs = extra.timeoutMs ?? Config.get("providerTimeout");
    let timer;
    let abort;
    let settled = false;
    const cancelled = new Promise((resolve) => {
      abort = () => {
        controller.abort();
        resolve({ ok: false });
      };
      parentSignal.addEventListener("abort", abort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(abort, timeoutMs);
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

  *normalizeDocumentSymbols(symbols, provider) {
    const result = [];
    const paths = new Map();
    for (const source of symbols) {
      if (!this.isValidSymbol(source)) {
        console.warn("symbol: invalid symbol", source);
      } else {
        const symbol = { ...source };
        try {
          this.normalizeSymbol(symbol, provider, paths);
          result.push(symbol);
        } catch (error) {
          console.warn("symbol: invalid symbol location", error.message);
        }
      }
      yield;
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
    this.trackedBundles.clear();
    this.sourceCaches.clear();
    this.sourceStates.clear();
    this.sourceDescriptors.clear();
    this.sourceChoices.clear();
    this.fileChoices.clear();
    this.editorSourceKeys.clear();
    this.sourceRevisions.clear();
    for (const subscription of this.sourceChoiceSubscriptions.values()) subscription.dispose();
    this.sourceChoiceSubscriptions.clear();
    this.stale.clear();
    this.emitter.dispose();
  }

  buildFileSymbolTree(symbols, options) {
    return DocumentWork.run(this.fileSymbolTreeEntries(symbols), options);
  }

  *fileSymbolTreeEntries(symbols) {
    const roots = [];
    const entries = [];
    for (const symbol of symbols) {
      entries.push({ ...symbol, children: [] });
      yield;
    }
    const stack = [];
    const latestByName = new Map();

    // File results are ordered by navigation position. A provider can still
    // supply a structural range whose start moves backwards; preserve the old
    // all-pairs semantics for that malformed-but-supported case. The ordinary
    // lexical case below is linear.
    let previousStart = null;
    let previousEnd = null;
    for (let entry of entries) {
      if (entry.range.isEmpty()) {
        yield;
        continue;
      }
      let startComparison = previousStart?.compare(entry.range.start) ?? -1;
      if (
        startComparison > 0 ||
        (startComparison === 0 && previousEnd.compare(entry.range.end) < 0)
      ) {
        return yield* this.buildFileSymbolTreeByScan(entries);
      }
      previousStart = entry.range.start;
      previousEnd = entry.range.end;
      yield;
    }

    for (let entry of entries) {
      let parent = null;

      if (!entry.range.isEmpty()) {
        while (stack.length && !stack.at(-1).range.containsRange(entry.range)) {
          stack.pop();
          yield;
        }

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
      yield;
    }

    return roots;
  }

  *buildFileSymbolTreeByScan(entries) {
    const roots = [];

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      let parent = null;

      if (!entry.range.isEmpty()) {
        for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
          const candidate = entries[candidateIndex];
          yield;
          if (candidate.range.isEmpty() || candidate.range.isEqual(entry.range)) continue;
          if (!candidate.range.containsRange(entry.range)) continue;
          if (!parent || parent.range.containsRange(candidate.range)) parent = candidate;
        }
      }

      if (!parent && entry.context) {
        for (let candidateIndex = index - 1; candidateIndex >= 0; candidateIndex--) {
          const candidate = entries[candidateIndex];
          yield;
          if (candidate.name === entry.context || candidate.shortName === entry.context) {
            parent = candidate;
            break;
          }
        }
      }

      (parent ? parent.children : roots).push(entry);
      yield;
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
    if (symbol.range) symbol.range = Range.fromObject(symbol.range).copy();
    symbol.position = symbol.position
      ? Point.fromObject(symbol.position, true)
      : symbol.range.start.copy();
    symbol.range ??= new Range(symbol.position.copy(), symbol.position.copy());
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

// Compatibility helpers share the required registry generation. Non-enumerable
// properties keep the class export shape while preserving writable test seams.
Object.defineProperties(module.exports, {
  Config: { value: Config, writable: true, configurable: true },
  ProviderBroker: { value: ProviderBroker, writable: true, configurable: true },
});
