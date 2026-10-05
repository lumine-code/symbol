# symbol.registry

The symbol hub's cached document symbols, workspace search and definition lookup.

|             |                                                            |
| ----------- | ---------------------------------------------------------- |
| Version     | `1.1.0`                                                    |
| Provided by | `provideSymbolRegistry()`                                  |
| Consumed by | `consumeSymbolRegistry(registry)` returning a `Disposable` |
| Owner       | `symbol`                                                   |

Document symbols, workspace symbols and definitions use separate provider contracts. Registry consumers share the same document cache and hierarchy as the hub's pickers.

## Registration

```json
{
  "consumedServices": {
    "symbol.registry": {
      "versions": { "^1.1.0": "consumeSymbolRegistry" }
    }
  }
}
```

## Contract

```ts
interface SymbolRegistry {
  getFileSymbols(editor: TextEditor): Promise<NormalizedSymbol[] | null>;
  peekFileSymbols(editor: TextEditor): NormalizedSymbol[] | null;
  getFileSymbolTree(editor: TextEditor): Promise<FileSymbolTree[] | null>;
  peekFileSymbolTree(editor: TextEditor): FileSymbolTree[] | null;
  onDidInvalidateFileSymbols(callback): Disposable;
  searchWorkspace(
    query?: string,
    options?: {
      signal?: AbortSignal;
      onSymbols?: (symbols: NormalizedSymbol[]) => void;
      onStatus?: (status: RequestStatus) => void;
    },
  ): Promise<NormalizedSymbol[] | null>;
  onDidInvalidateWorkspaceSymbols(callback): Disposable;
  findDefinitions(
    editor: TextEditor,
    options?: {
      range?: Range;
      signal?: AbortSignal;
      onStatus?: (status: RequestStatus) => void;
    },
  ): Promise<NormalizedSymbol[] | null>;
  providers(): ProviderDescriptor[];
  onDidChangeProviders(callback): Disposable;
}
```

Every normalized symbol has a real `Point` position, a real `Range`, `providerName` and `providerId`. A tree node adds `children`. Structural range containment determines hierarchy; `context` supplies the parent for point-only symbols. Provider descriptors contain `name`, `packageName` and `role` (`document`, `workspace` or `definition`). Full types are in `lib/main.d.ts`.

## Minimal example

```js
consumeSymbolRegistry(registry) {
  const refresh = async editor => {
    const tree = await registry.getFileSymbolTree(editor);
    if (tree !== null) render(tree);
  };
  return registry.onDidInvalidateFileSymbols(({ editor }) => {
    if (editor) refresh(editor);
  });
}
```

## Behavior

Concurrent document requests share one provider run. Complete results, including empty arrays, are cached until text, grammar, configuration or provider availability changes. Flat and tree results use the same snapshot. A `null` result means unavailable or cancelled; retain the previous presentation or wait for invalidation. `peek` never starts work.

Workspace search has no editor argument. It snapshots current project roots, asks every workspace provider and deduplicates navigation destinations. `onSymbols` receives accumulated snapshots. `onStatus` distinguishes successful empty results from unavailable or starting backends, partial failure and errors. Changing project roots or cancelling the request discards stale responses.

Definition lookup uses the requested range or the editor's cursor. It is uncached and cancelled when its source changes. Location records retain notebook cell URIs and positions in the appropriate source coordinates.

## Teardown

Return a disposable from consumption and remove every event subscription it owns. Requests on a deactivated registry resolve `null`. Registration of providers remains on their separate services, not on this consumer-facing registry.

## Versioning

`1.1.0` provided, `^1.1.0` consumed. This preproduction contract is migrated atomically across the fleet; the former project and declaration methods are removed without aliases.
