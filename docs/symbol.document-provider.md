# symbol.document-provider

Supplies a complete symbol list for the current document.

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Version     | `1.0.0`                                                            |
| Provided by | `provideDocumentSymbolProvider()`                                  |
| Consumed by | `consumeDocumentSymbolProvider(provider)` returning a `Disposable` |
| Owner       | `symbol`                                                           |

## Registration

Declare `symbol.document-provider` in `providedServices` at version `1.0.0`. Publish the provider during synchronous bootstrap; keep expensive work behind its methods.

## Contract

| Required member                       | Description                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `name`, `packageName`                 | Human-readable provider name and the exact package name.                                        |
| `canProvideDocumentSymbols(editor)`   | Boolean or numeric availability, optionally asynchronous; do not begin extraction here.         |
| `getDocumentSymbols(editor, request)` | Complete array of symbols, optionally asynchronous; `request` carries `signal` and `timeoutMs`. |

| Optional member                            | Description                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `onDidInvalidateDocumentSymbols(callback)` | Returns a disposable; notify with `{editor}` or `{editor: null}` when every document is stale. |

A symbol requires `name` and `position` or `range`. Positions and ranges accept editor objects, arrays or plain objects. Optional `tag`, `context`, `shortName` and `icon` enrich the presentation. Give structural ranges when available so the registry can construct the hierarchy.

## Minimal example

```js
provideDocumentSymbolProvider() {
  return {
    name: "Example",
    packageName: "example",
    canProvideDocumentSymbols: editor => editor.getGrammar().scopeName === "source.example",
    getDocumentSymbols: (editor, { signal }) => signal.aborted ? null : parse(editor.getText()),
  };
}
```

## Behavior

The hub chooses one document source. Availability scores are clamped to one; user preferences break ties and can override the default ordering. Each capability check has a 500 ms deadline. A failed, unavailable or timed-out source lets the next eligible source answer. A successful empty array is a valid answer and stops fallback.

The current buffer is authoritative, including unsaved changes. The hub shares in-flight work and caches complete results per editor. Buffer, grammar and provider changes invalidate the result. Return `null` on cancellation; check `signal` after awaits. Each extraction attempt receives its own configured timeout budget.

## Teardown

Dispose the invalidation subscription when the service edge disappears. Providers own their resources; unregistering the hub does not destroy another package's provider.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. This replaces the combined symbol provider contract without a compatibility bridge.
