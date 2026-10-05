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

| Required member                             | Description                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`, `packageName`                       | Human-readable provider name and the exact package name.                                                             |
| `getDocumentSymbolSources(editor, request)` | Metadata for sources applicable to this buffer; `request` carries an optional `signal`. Do not extract symbols here. |
| `getDocumentSymbols(editor, request)`       | Complete array from exactly `request.sourceId`; the request also carries `signal` and `timeoutMs`.                   |

| Optional member                            | Description                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `onDidInvalidateDocumentSymbols(callback)` | Returns a disposable; notify with `{editor}` or `{editor: null}` when every document is stale. |

A symbol requires `name` and `position` or `range`. Positions and ranges accept editor objects, arrays or plain objects. Optional `tag`, `context`, `shortName` and `icon` enrich the presentation. Give structural ranges when available so the registry can construct the hierarchy.

Each source descriptor has a globally unique, stable `id`, a full `name`, a compact `shortLabel`, a finite nonnegative `score` and `state` (`ready`, `starting` or `unavailable`). Optional `message` explains availability. Optional `execution` is `local` or `remote`, defaulting to `remote`; this controls extraction deadlines, independently of availability. Scores are clamped to one; only ready sources with a positive score can supply symbols. A provider may expose several sources, such as one for each applicable language backend. Keep source IDs independent of display labels, workspace roots and server process generations. A source request must decline an unknown, unsupported or withdrawn ID rather than substitute another source.

## Minimal example

```js
provideDocumentSymbolProvider() {
  return {
    name: "Example",
    packageName: "example",
    getDocumentSymbolSources: editor => [{
      id: "example", name: "Example", shortLabel: "EX", score: 1,
      state: editor.getGrammar().scopeName === "source.example" ? "ready" : "unavailable",
    }],
    getDocumentSymbols: (editor, { sourceId, signal }) =>
      sourceId === "example" && !signal.aborted ? parse(editor.getText()) : null,
  };
}
```

## Behavior

The hub chooses one document source. Auto orders ready sources by score and user preference, with a 500 ms deadline for each metadata listing. A failed, unavailable or timed-out source lets the next eligible source answer. A successful empty array is a valid answer and stops fallback. A manual selection requests only that source; failures remain visible and never trigger a different source. Source selection affects document symbols; workspace search and definition lookup keep their own routing.

The current buffer is authoritative, including unsaved changes. The hub shares in-flight work and caches complete results per editor and source. Switching a source cancels obsolete requests and invalidates every consumer of the selected snapshot while retaining current-version source caches. Buffer, grammar and provider changes invalidate those caches. Return `null` on cancellation; check `signal` after awaits. Each remote extraction attempt receives its own configured response timeout. Local extraction receives `timeoutMs: 0` and can finish a large buffer without that deadline; it remains cancellable by the same lifecycle signal and should yield during expensive work. A timeout or failure of a remote source must not consume or cancel the local fallback's work budget.

## Teardown

Dispose the invalidation subscription when the service edge disappears. Providers own their resources; unregistering the hub does not destroy another package's provider.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. This replaces the combined symbol provider contract without a compatibility bridge.
