# symbol

Jump to a function, method, or symbol in the current editor or across the project.

Fork of [pulsar-edit/pulsar](https://github.com/pulsar-edit/pulsar) (`packages/symbols-view`).

The hub of the symbol domain: it gathers symbols from every separate document, workspace and definition providers, caches them per editor, and serves them — to its own pickers and, through the `symbol.registry` service, to any other package that wants them.

## Features

- **File symbols**: browse and jump to any symbol in the active editor.
- **Source selection**: choose a document source from the TS or LS status item, keep the choice for one file in the session, or save it for the grammar.
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
- `symbol:select-document-source`: choose a source for this file or its grammar,
- `symbol:show-active-providers`: list the symbol providers currently available.

Commands available in `lumine-text-editor:not([mini])`:

- `symbol:toggle-file-symbols`: browse the symbols in the active editor,
- `symbol:go-to-definition`: jump to the definition of the symbol under the cursor,
- `symbol:return-from-definition`: return to the position before the last definition jump.

Commands available in `.symbol-source-selector`:

- `symbol:use-document-source`: use the selected source for this file in the current session,
- `symbol:use-document-source-for-grammar`: save the selected source for the grammar.

## Usage

The status item beside the grammar selector shows the document source, including a successful empty result. Its tooltip names the source. In the selector, Auto detect has a checkmark and its effective source has an icon for automatic selection. Short lists keep their natural provider order. When the list scrolls, the current source appears directly below Auto detect, followed by a separator before the remaining sources. A manual choice has one checkmark. Auto detect tries eligible sources in preference order and falls back after an unavailable, failed or timed-out source. The selector lists language servers only when they support document symbols, while Tree-sitter remains available even when the grammar has no tags. A manual choice uses exactly that source and reports its failure; an unavailable manual source remains visible and disabled. File choices are restored with the project's window state, including project switches in the same window, and take precedence over grammar settings; saving a grammar choice removes this file's override while preserving overrides belonging to other files. Outline, breadcrumbs and the file-symbol picker share the selected source and cache.

Remote document sources use the configured response timeout. Local Tree-sitter extraction can finish large buffers without that deadline; editing the buffer or changing its source still cancels obsolete work.

## Services

- [`symbol.document-provider`](docs/symbol.document-provider.md): consumed to obtain symbols for the current buffer.
- [`symbol.workspace-provider`](docs/symbol.workspace-provider.md): consumed to search active language backends.
- [`symbol.definition-provider`](docs/symbol.definition-provider.md): consumed to resolve definitions.
- [`symbol.registry`](docs/symbol.registry.md): provided to serve aggregated, cached symbols to other packages.
- `hyperclick.provider`: provided to let you follow a symbol to its definition with a click.
- `status-bar`: consumed to show the current document source and open its selector.
- `background-tips.provider`: provided to explain symbol navigation and source selection.

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
