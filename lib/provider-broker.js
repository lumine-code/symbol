const { CompositeDisposable, Emitter } = require("lumine");
const Config = require("./config");

const METHODS = {
  document: ["canProvideDocumentSymbols", "getDocumentSymbols"],
  workspace: ["searchWorkspaceSymbols"],
  definition: ["canProvideDefinitions", "getDefinitions"],
};
const CAPABILITY_TIMEOUT = 500;

module.exports = class ProviderBroker {
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
};
