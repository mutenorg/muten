# ir - IR transforms & validation

The middle of the pipeline: it reshapes the parser's nested IR into the canonical flat `Doc` that
gets validated, mutated and compiled.

| File | What it does |
|---|---|
| `compose.ts` | Inlines every part instance with its tree, substituting `$param`s with the call args (a ref passed to a text param stays live). Parts disappear at build time. |
| `flatten.ts` | Nested authoring tree → flat `Doc`, addressable by id (`n1`, `n2`, … in pre-order). The only thing validated and compiled. |
| `validate.ts` | The oracle's entry: the page's facts (state, gets, stores, params, anchors), reference/expression/member checks, then the walk over nodes and the action checks, each in its own file. |
| `validate-nodes.ts` | The walk over the tree: known types, required props, refs in scope, links that land, icons, charts, every expression a node carries. |
| `validate-actions.ts` | Effects and actions: `mutates`, list ops that fit their list, calls, `send` on a live query, and failure handling that can never run. |
| `calls.ts` | What a call may name (built-in, `use`'d function, a `get name(…)` here or in a store) and with how many values. |
| `a11y.ts` | Warnings a screen reader needs: unnamed fields, icon-only controls, more than one h1. |
| `icon-names.ts` | Every name an `Icon "{…}"` can take, when the page spells them out. |
| `refs.ts` | The single semantic resolver both the oracle and the emitter consult (what exists, what is behind a list, get order and cycles). |
| `imports.ts` | The `use` lines a composed page ends up with (a part carries its own). |
| `leaf-children.ts` | A childless primitive given children: an error instead of children that never render. |
| `print.ts` | IR → `.muten` source, the inverse of parse. |
