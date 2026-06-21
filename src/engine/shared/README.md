# shared — contracts & cross-cutting primitives

The vocabulary every other domain speaks. Nothing here imports a sibling domain; everything imports
from here. Keeping the contracts in one place is what lets the stages stay decoupled and honestly typed.

| File | What it holds |
|---|---|
| `types.ts` | **Every model/interface** the engine passes around — tokens, the expression AST, the IR, the flat `Doc`, diagnostics, compile context, the build/runtime shapes. The single source of types; nothing is declared next to the code that uses it. |
| `vocab.ts` | **Every matched string as a named enum** — token kinds (`Tk`), punctuation (`Pn`), keywords (`Kw`), node types (`Nt`), operators (`BOp`/`UOp`), AST/statement kinds (`Ek`/`StOp`), modifiers (`Mod`), formats (`Fmt`), field kinds (`Fk`). No magic strings live downstream. |
| `diagnostics.ts` | The error language: `ParseError`, `diag()`, `closest()` (edit-distance "did you mean…?"), `formatDiagnostic()`. Shaped for an editor's squiggles and for an AI's auto-fix. |
