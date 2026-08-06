# symbol

Jump to a function, method, or symbol in the current editor or across the project.

The hub of the symbol domain: it gathers symbols from every `symbol.provider`, caches them per editor, and serves them — to its own pickers and, through the `symbol.registry` service, to any other package that wants them.

## Features

- **File symbols**: browse and jump to any symbol in the active editor.
- **Project symbols**: search for symbols across the entire project.
- **Go to declaration**: navigate to the declaration of the symbol under the cursor.
- **Return from declaration**: jump back to where you were before following a declaration.
- **Pluggable providers**: gather symbols from any package that supplies a symbol provider.
- **Shared registry**: one fetch per editor serves every consumer through the `symbol.registry` service.
- **Hyperclick support**: follow a symbol to its declaration with a click.

## Installation

To install `symbol` search for _symbol_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/symbol`.

## Commands

Commands available in `atom-workspace`:

- `symbol:toggle-project-symbols`: search for a symbol across the whole project,
- `symbol:show-active-providers`: list the symbol providers currently available.

Commands available in `atom-text-editor:not([mini])`:

- `symbol:toggle-file-symbols`: browse the symbols in the active editor,
- `symbol:go-to-declaration`: jump to the declaration of the symbol under the cursor,
- `symbol:return-from-declaration`: return to the position before the last declaration jump.

## Services

- **[symbol.provider](docs/symbol.provider.md)** (`^1.0.0`): consumed to allow external sources to suggest symbols for a given file or project.
- **[symbol.registry](docs/symbol.registry.md)** (`1.0.0`): provided to serve aggregated, cached symbols to other packages.
- **hyperclick.provider** (`1.0.0`): provided to let you follow a symbol to its declaration with a click.

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
