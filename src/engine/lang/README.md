# lang — the front-end (`.muten` text → IR)

Turns source text into the nested IR the rest of the pipeline consumes. Three layers, each building
on the one below so the cursor and the expression grammar are never duplicated.

| File | What it does |
|---|---|
| `lexer.ts` | `Lexer`: source text → a flat token stream. Two-char operators come from a table; scanners are named methods; the loop is a flat dispatch (no growing if-chain). |
| `grammar.ts` | `Grammar`: the reading foundation — the token cursor (`peek`/`at`/`next`/`eat`), the **expression grammar** (a precedence ladder + `{ }` interpolation), and the literal-value reader. |
| `parse.ts` | `Parser extends Grammar`: the **screen grammar** — top-level declarations (entity/state/action/routes/…) and the node tree. Dispatch is data-driven (keyword→handler, modifier→handler, method→builder are Maps). |
| `manifest.ts` | The language's vocabulary **and its docs**: every primitive's props/snippet/doc, the keywords, modifiers and action ops. The single source the parser, the validator and the editor autocomplete all read. |
