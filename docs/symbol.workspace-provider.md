# symbol.workspace-provider

Searches workspace symbols independently of the active document.

|             |                                                                     |
| ----------- | ------------------------------------------------------------------- |
| Version     | `1.0.0`                                                             |
| Provided by | `provideWorkspaceSymbolProvider()`                                  |
| Consumed by | `consumeWorkspaceSymbolProvider(provider)` returning a `Disposable` |
| Owner       | `symbol`                                                            |

## Registration

Declare `symbol.workspace-provider` in `providedServices` at version `1.0.0` and publish the provider during synchronous bootstrap.

## Contract

| Required member                          | Description                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`, `packageName`                    | Human-readable provider name and the exact package name.                                                       |
| `searchWorkspaceSymbols(query, request)` | Array or promise of symbols; `request` carries `paths`, `signal`, `timeoutMs` and optional progress callbacks. |

| Optional member                             | Description                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `onDidInvalidateWorkspaceSymbols(callback)` | Returns a disposable; notify when backend availability, capabilities or project scope change. |

Each symbol requires `name`, a position or range, and a destination: `path`, `uri` or `directory` plus `file`. Notebook locations can additionally carry `cell` and a cell URI.

## Minimal example

```js
provideWorkspaceSymbolProvider() {
  return {
    name: "Example",
    packageName: "example",
    searchWorkspaceSymbols: (query, { paths, signal }) => searchActiveBackends(paths, query, signal),
  };
}
```

## Behavior

The hub asks all registered workspace providers concurrently. Query changes cancel the previous request; the picker debounces new queries for 200 ms. Backend failures do not discard other results.

`onSymbols(symbols)` publishes the provider's accumulated snapshot, replacing its previous snapshot. `onStatus({state, message?})` reports `ready`, `unavailable`, `starting`, `partial` or `error`. Distinguish unavailable backends from a successful search with no matches. A cancelled request resolves `null`.

Results are deduplicated by destination, cell, name, kind and navigation position. Provider identity is excluded. Preserve cancellation and project scope; do not open documents or start extra language servers merely to answer this request.

## Teardown

Dispose subscriptions when the service edge disappears. Check the request's signal before publishing progress or results.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. No combined-provider compatibility path is retained.
