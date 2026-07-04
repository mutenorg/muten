# src/engine - file conventions

All Muten source is TypeScript under `src/` (this engine, plus the runtime, the esbuild runner, the
CLI, build/lint and index). `npm run build` = `tsc` (type-check, strict) + `esbuild` → `dist/**/*.js`,
**minified, per-file** (the module graph is preserved and the `#engine/*` imports stay intact, so
nothing bundles into a heavy monolith). The package, the demos, the tests and the VS Code extension
all consume `dist/`. **There is no committed `.js` - `dist/` is generated. Edit `src/**/*.ts`.**

## Every file has the same shape (top → bottom)

1. **Header comment** - what this stage does and where it sits in the pipeline.
2. **Imports** - `#engine/*` absolute paths; `import type { … }` for type-only imports.
3. **Constants & tables** - dispatch tables, lookup maps, fixed vocabulary. *Data, not logic.*
4. **Module helpers** - small, named, single-purpose pure functions.
5. **The main export** - a class, or the exported functions.
   - In a class: **fields first**, then the **constructor**, then **methods** grouped under
     `// ── section ──` banners (e.g. cursor, declarations, expressions).

## Hard rules

- **≤ 500 lines per file.** Split anything bigger into digestible, single-purpose pieces.
- **Honest types only - never silence the compiler.** No `any`, `unknown`, `as` (incl. `as const`),
  `!` non-null assertions, `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`, or any lint disabling.
  No phantom `Record<string, string>` (open-keyed maps use an index signature whose VALUE is a
  real named type).
- **Types/models** live in `types.ts`; **string/keyword/operator constants** in `vocab.ts`;
  shared pure helpers may live in their own `*-helpers.ts`. Never declare an interface or a magic
  string next to the code that uses it.
- **No magic strings.** Match against `vocab` enums (`Tk`, `Kw`, `Pn`, `Nt`, `BOp`, …).
- **Dispatch with data tables** (`Map` / array), never a growing `if/else N` chain.
- **DRY.** A pattern written twice becomes a named helper; never copy a block between branches.
- **Descriptive names.** `source` / `index` / `value` - never `s` / `i` / `v` outside a
  one-line lambda.

## The pipeline

```
.muten ─[parse]→ IR ─[compose]→ tree ─[flatten]→ Doc ─[validate]→ ✓ ─[compile]→ JS
                  (vocab + types are the shared contracts; tokens = the styling vocabulary)
```
