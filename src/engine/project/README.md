# project - filesystem & whole-app awareness

The only domain that touches the disk. Everything else is pure (text → IR → Doc → string); here is
where a single page becomes a real, project-aware build, and where the editor's smart linting lives.

| File | What it does |
|---|---|
| `load.ts` | A page → everything needed to compile it: parse, gather + compose parts (shared + local + inline), hoist the used parts' entity/state/mock, gather styles, flatten. |
| `analyze.ts` | The project-aware analyzer behind the live linter/autocomplete: loads all parts, hoists their state so `@refs` validate for real, knows the store domains + theme. Consumed by the VS Code extension and the CLI. |
| `routes.ts` | Reads `src/app.muten` → the route table (the app root); throws on a missing/duplicate/dangling route. |
| `styles.ts` | Resolves a page's colocated stylesheet (`.css`, or `.scss` via the optional `sass` dependency). |
| `ssr.ts` | Build-time SSR/SSG: a minimal DOM the compiled page runs against, so a reactive page pre-renders to real HTML by executing the **real** compiler output (no parallel renderer to drift) + `fetchSources` (fetch a page's GET `sources` at build, applying the `api` config, so source-backed lists pre-render too). |
| `context.ts` | The project's store facts (members, actions, `get` functions, entities, self-updating actions) derived ONCE for validate and compile. |
| `check-app.ts` | App-level validation shared by `check` and `build`: every `.store` body and every route guard. |
| `check-tests.ts` | The `.test` files: found, parsed and checked (unknown step, an `open` to no route, a test that sees nothing); what `muten test` runs. |
| `env.ts` | `env { }` in muten.config: the active environment's values as the `env` store, inside api strings, and as `import.meta.env.MUTEN_*`. |
| `layouts.ts` | `layout` checks for app.muten: every `in name` exists, each layout has one `slot`. |
| `imports.ts` | Anchors a part file's relative `use` paths to the app root. |
| `icon-check.ts` | Does `set:name` exist? Reads the installed set's icons.json, cached by mtime. |
| `js-antipatterns.ts` | The oracle reaching into a Custom's `.js`: UI muten already owns, hand-rolled. |
| `map.ts` | `app.map.json`: routes, models, state and sources, without compiling (what an AI reads first). |
