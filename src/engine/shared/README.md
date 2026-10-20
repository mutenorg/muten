# shared - contracts & cross-cutting primitives

The vocabulary every other domain speaks. Nothing here imports a sibling domain; everything imports
from here. Keeping the contracts in one place is what lets the stages stay decoupled and honestly typed.

| File | What it holds |
|---|---|
| `types.ts` | **Every model/interface** the engine passes around - tokens, the expression AST, the IR, the flat `Doc`, diagnostics. The single place to import types from; nothing is declared next to the code that uses it. It re-exports the two files below. |
| `types-compile.ts` | The shapes of compiling and checking a page: options, the compile context, the `Emitter` every node generator receives, what each check (`NodeCheck`, `ActionCheck`, `CallFacts`) reads. |
| `types-tooling.ts` | The shapes of the tools around the compiler: editor completions, the browser runtime, build/plugins, `.test` files. |
| `vocab.ts` | **Every matched string as a named enum** - token kinds (`Tk`), punctuation (`Pn`), keywords (`Kw`), node types (`Nt`), operators (`BOp`/`UOp`), AST/statement kinds (`Ek`/`StOp`), modifiers (`Mod`), formats (`Fmt`), field kinds (`Fk`). No magic strings live downstream. |
| `diagnostics.ts` | The error language: `ParseError`, `diag()`, `closest()` (edit-distance "did you mean…?"), `formatDiagnostic()`. Shaped for an editor's squiggles and for an AI's auto-fix. |
| `source.ts` | The `sources`/`api` semantics in ONE place: `sourceRequest` (a descriptor + the `api` config → a complete HTTP request - base/relative join, header merge, named clients) and `sourceRows` (pick the array out of a response, dotted `at`). The build imports these; the browser data layer inlines them verbatim via `toString()`, so build-time SSG and runtime fetching can never drift. |
