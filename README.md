# symbol

Jump to a function, method, or symbol in the current editor or across the project.

The hub of the symbol domain: it gathers symbols from every separate document, workspace and definition providers, caches them per editor, and serves them — to its own pickers and, through the `symbol.registry` service, to any other package that wants them.

## Features

- **File symbols**: browse and jump to any symbol in the active editor.
- **Project symbols**: search symbols supplied by active language backends.
- **Go to definition**: navigate to the definition of the symbol under the cursor.
- **Return from definition**: jump back to where you were before following a definition.
- **Pluggable providers**: gather symbols from any package that supplies a symbol provider.
- **Shared registry**: one fetch per editor serves both flat symbol lists and hierarchical trees through the `symbol.registry` service.
- **Hyperclick support**: follow a symbol to its definition with a click.

## Installation

To install `symbol` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/symbol`.

## Commands

Commands available in `lumine-workspace`:

- `symbol:toggle-project-symbols`: search symbols from active language backends,
- `symbol:show-active-providers`: list the symbol providers currently available.

Commands available in `lumine-text-editor:not([mini])`:

- `symbol:toggle-file-symbols`: browse the symbols in the active editor,
- `symbol:go-to-definition`: jump to the definition of the symbol under the cursor,
- `symbol:return-from-definition`: return to the position before the last definition jump.

## Services

- [`symbol.document-provider`](docs/symbol.document-provider.md): consumed to obtain symbols for the current buffer.
- [`symbol.workspace-provider`](docs/symbol.workspace-provider.md): consumed to search active language backends.
- [`symbol.definition-provider`](docs/symbol.definition-provider.md): consumed to resolve definitions.
- [`symbol.registry`](docs/symbol.registry.md): provided to serve aggregated, cached symbols to other packages.
- `hyperclick.provider`: provided to let you follow a symbol to its definition with a click.

## Customization

Restyle the symbols list by adding CSS to your `styles.css`. For example, to enlarge the entries and loosen their spacing:

```css
.symbol .list-group li {
  font-size: 14px;
  padding: 6px 10px;
}
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
