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
  listDocumentSources(editor: TextEditor): Promise<DocumentSourceDescriptor[]>;
  getDocumentSourceState(editor: TextEditor): DocumentSourceState;
  setDocumentSource(
    editor: TextEditor,
    sourceId: string | null,
    options?: { scope: "file" | "grammar" },
  ): void;
  onDidChangeDocumentSource(callback): Disposable;
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

Every normalized symbol has a real `Point` position, a real `Range`, `providerName` and `providerId`. For document symbols, these identify the full source name and stable source ID, including a particular language backend. A tree node adds `children`. Structural range containment determines hierarchy; `context` supplies the parent for point-only symbols. Provider descriptors contain `name`, `packageName` and `role` (`document`, `workspace` or `definition`). Document source descriptors additionally contain `id`, `shortLabel`, `score`, availability `state`, `execution` (`local` or `remote`) and optional `message`. Full types are in `lib/main.d.ts`.

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

Concurrent document requests share one provider run. Complete results, including empty arrays, are cached until text, grammar, configuration or provider availability changes. Flat and tree results use the same snapshot. A `null` result means unavailable or cancelled. Guard the editor and request generation before applying a result: ignore obsolete responses, and clear previous symbols when the current request has no result. Breadcrumbs retain file-path information. `peek` never starts work.

Remote document sources use the configured response timeout. Local sources can finish large buffers without that deadline and remain cancellable by edits, source changes and teardown. Auto can therefore fall back from a timed-out language server to Tree-sitter without applying the same response deadline to local extraction.

`listDocumentSources` lists metadata without extracting symbols. `getDocumentSourceState` reports `mode` (`auto` or `manual`), choice `scope` (`file` or `grammar`), selected `sourceId` (`null` for Auto), source descriptor and request `status` (`idle`, `loading`, `ready`, `starting`, `unavailable` or `error`). The source descriptor is independent of result count, so a ready empty array still identifies its source. `onDidChangeDocumentSource` receives `{editor, state}`. Unavailable manual sources retain their descriptive name when known.

`setDocumentSource(editor, id)` selects one source for that file in the window session; `null` explicitly selects Auto for the file. File choices use document URIs or serialized buffer IDs for new buffers and are serialized in the package state within the project's window state. A file choice takes precedence over grammar configuration. `{scope: "grammar"}` saves the choice in grammar-scoped `symbol.documentSource` and clears the current file's override; other files keep their overrides. Switching sources cancels old requests and emits the existing `onDidInvalidateFileSymbols` event, so all consumers refresh together. Source caches are retained for the unchanged buffer and cleared on source or buffer invalidation. Manual selection does not silently fall back. Workspace symbols and definitions are independent of this selection.

Workspace search has no editor argument. It snapshots current project roots, asks every workspace provider and deduplicates navigation destinations. `onSymbols` receives accumulated snapshots. `onStatus` distinguishes successful empty results from unavailable or starting backends, partial failure and errors. Changing project roots or cancelling the request discards stale responses.

Definition lookup uses the requested range or the editor's cursor. It is uncached and cancelled when its source changes. Location records retain notebook cell URIs and positions in the appropriate source coordinates.

## Teardown

Return a disposable from consumption and remove every event subscription it owns. Requests on a deactivated registry resolve `null`. Registration of providers remains on their separate services, not on this consumer-facing registry.

## Versioning

`1.1.0` provided, `^1.1.0` consumed. This preproduction contract is migrated atomically across the fleet; the former project and declaration methods are removed without aliases.
