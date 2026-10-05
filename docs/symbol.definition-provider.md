# symbol.definition-provider

Resolves the definition of a symbol at a document position.

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| Version     | `1.0.0`                                                        |
| Provided by | `provideDefinitionProvider()`                                  |
| Consumed by | `consumeDefinitionProvider(provider)` returning a `Disposable` |
| Owner       | `symbol`                                                       |

## Registration

Declare `symbol.definition-provider` in `providedServices` at version `1.0.0` and publish the provider during synchronous bootstrap.

## Contract

| Required member                   | Description                                                               |
| --------------------------------- | ------------------------------------------------------------------------- |
| `name`, `packageName`             | Human-readable provider name and the exact package name.                  |
| `canProvideDefinitions(editor)`   | Boolean or numeric availability, optionally asynchronous.                 |
| `getDefinitions(editor, request)` | Definition locations; request carries `range?`, `signal` and `timeoutMs`. |

There are no optional provider members. Each location requires a display name and a position or range. Supply a destination path or URI for cross-document navigation; notebook cells retain their cell URI.

## Minimal example

```js
provideDefinitionProvider() {
  return {
    name: "Example",
    packageName: "example",
    canProvideDefinitions: editor => supports(editor),
    getDefinitions: (editor, request) => resolveAt(editor, request.range?.start, request.signal),
  };
}
```

## Behavior

Resolve the requested range's start, or the current cursor position when no range is supplied. The hub chooses an eligible provider using availability and user preferences. A successful empty answer means no definition was found; it is not a provider failure.

Definitions are uncached. Editing, changing grammar or destroying the source document cancels an outstanding lookup. The command and hyperclick share this contract; a hyperclick callback uses its already-fetched result rather than querying again.

## Teardown

Unregister the provider when the service edge disappears. Provider resources remain owned by its package.

## Versioning

`1.0.0` provided, `^1.0.0` consumed. No name-based tags-file fallback is supplied.
