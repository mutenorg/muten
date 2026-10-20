# lang - the front-end (`.muten` text → IR)

Turns source text into the nested IR the rest of the pipeline consumes. The parser is a stack of classes, each
building on the one below (grammar → readers → actions → declarations → tree), so the cursor and the expression
grammar are never duplicated and every file stays one concern.

| File | What it does |
|---|---|
| `lexer.ts` | Source → tokens; JS-isms get a hint instead of «unexpected character». |
| `grammar.ts` | The token cursor and the expression/value grammar (the base class). |
| `readers.ts` | Small shared readers: types, dotted names, args, clauses, durations, constraints. |
| `parse-actions.ts` | `get` (with parameters too), `action` (+ `failed { }`) and the statements of a body, by a dispatch table. |
| `parse-decls.ts` | The data declarations: entity, state/store, mock, sources, api, meta, routes, const, theme, `use` of a component. |
| `parse.ts` | `Parser`: the entry, the declarations that hold a tree (shell, layout, part) and the node tree with its modifiers. |
| `manifest.ts` | The vocabulary: primitives and their props, keywords, built-ins, action ops, and the docs the editor shows for each. |
| `test-parse.ts` | A `.test` file → its tests (`open`, `press`, `fill … with`, `see`, `see no`, `wait`). |
