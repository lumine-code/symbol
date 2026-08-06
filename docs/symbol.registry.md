# symbol.registry

The symbol hub's aggregated symbol source: cached per-editor file symbols, project search, and declaration lookup.

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| Version     | `1.0.0`                                                    |
| Provided by | `provideSymbolRegistry()` returning the registry object    |
| Consumed by | `consumeSymbolRegistry(registry)` returning a `Disposable` |
| Owner       | [`symbol`](https://github.com/lumine-code/symbol)          |

Symbols come from packages providing [symbol.provider](symbol.provider.md); the hub selects among them, enforces timeouts and exclusivity, normalizes what they return, and caches file results per editor. Consume this service instead of `symbol.provider` when you want symbols: one fetch serves every consumer, and provider selection — scoring, the user's provider preferences, the `canProvideSymbols` timeout — stays in one place.

## Registration

In your `package.json`:

```json
{
  "consumedServices": {
    "symbol.registry": {
      "versions": { "^1.0.0": "consumeSymbolRegistry" }
    }
  }
}
```

Export `consumeSymbolRegistry(registry)` from your main module and **return a `Disposable`** that drops every subscription you built from the payload.

## Contract

```ts
type ProviderDescriptor = { name: string; packageName: string; isExclusive: boolean };

interface SymbolRegistry {
  // Cached per-editor file symbols. Concurrent calls for the same editor
  // share one in-flight run; a completed run is cached until invalidated.
  // Resolves the sorted symbol list ([] when the selected providers found
  // nothing), or null when no provider could serve the request or the run
  // was superseded by an invalidation — on null, keep what you have or wait
  // for the next invalidation event.
  getFileSymbols(editor: TextEditor, options?: { listController? }): Promise<FileSymbol[] | null>;

  // The cache, read without fetching. Non-null only when the entry is
  // complete (no provider's portion pending re-query).
  peekFileSymbols(editor: TextEditor): FileSymbol[] | null;

  // editor null = every editor (config change); provider null = every
  // provider. Fires on grammar change, save, path change, buffer reload,
  // buffer destroy, buffer stop-changing, `symbol.*` config change, provider
  // add/remove, and a provider's own onShouldClearCache.
  onDidInvalidateFileSymbols(
    cb: (bundle: { editor: TextEditor | null; provider: ProviderDescriptor | null }) => void,
  ): Disposable;

  // Uncached. All capable providers, exclusivity not enforced. onSymbols
  // streams partial results as providers answer; abort the signal when the
  // query changes.
  searchProject(
    editor: TextEditor,
    query?: string,
    options?: { signal?; onSymbols?; listController? },
  ): Promise<ProjectSymbol[] | null>;

  // Uncached go-to-declaration lookup. The query is derived from `range`
  // when given; resolves [] when no provider is capable.
  findDeclarations(
    editor: TextEditor,
    options?: { range?; signal?; listController? },
  ): Promise<ProjectSymbol[] | null>;

  providers(): ProviderDescriptor[]; // descriptors, never raw providers
  onDidChangeProviders(cb: () => void): Disposable;
}
```

`FileSymbol` and `ProjectSymbol` are the shapes of [symbol.provider](symbol.provider.md), after the hub's normalization: every symbol carries a `position` (derived from `range` when the provider gave only that), `providerName`, and `providerId`, and file results arrive sorted by position.

## Minimal example

```js
module.exports = {
  consumeSymbolRegistry(registry) {
    const render = async () => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) return;
      const symbols = await registry.getFileSymbols(editor);
      if (!symbols) return; // superseded or no providers — keep what we have
      this.view.setSymbols(symbols);
    };

    render();
    return registry.onDidInvalidateFileSymbols(({ editor }) => {
      if (editor && editor !== atom.workspace.getActiveTextEditor()) return;
      render();
    });
  },
};
```

## Behavior

**One fetch, shared.** Concurrent `getFileSymbols` calls for the same editor join one in-flight run, and a completed run is cached until invalidated — a picker opened right after an outline refresh renders instantly from the same list. The hub does no eager work: fetches happen when a consumer asks, and a consumer refetching on invalidation is what keeps the cache warm for the next one.

**Invalidation aborts and announces.** Anything that makes symbols stale — an edit settling, a save, a grammar change, a provider arriving — aborts that editor's in-flight run (its promise resolves `null`) and fires `onDidInvalidateFileSymbols`. A `null` resolution is not an error: keep what you are showing and let the event drive the next ask. Abandoning a call does **not** abort the shared fetch — the run completes, bounded by the `providerTimeout` setting, and warms the cache.

**`listController` reaches only the exclusive provider.** Pass one (an object with `set`/`clear`, see [symbol.provider](symbol.provider.md)) when your UI can show the provider's loading and error messages; omit it and the hub substitutes a no-op, so providers never see the difference.

**Search is per-request.** `searchProject` and `findDeclarations` bypass the cache and honor your `signal` — abort it on each keystroke, as the hub's own project picker does.

## Teardown

Dispose every subscription in the `Disposable` you return from `consumeSymbolRegistry`. Registry methods on a deactivated hub are inert: requests resolve `null` and event subscriptions still return disposables. Provider registration is deliberately absent from this service — providers register through [symbol.provider](symbol.provider.md).

## Versioning

`1.0.0` provided, `^1.0.0` consumed. A change that breaks this shape gets a new service name rather than a new major version, and both sides move in the same release.
