# compile — the back-end (Doc → runnable JS)

The thesis made concrete: **no virtual DOM**. It emits imperative DOM construction plus fine-grained
`effect`s that touch only what the changed state feeds. A page with no reactivity at all compiles to
plain HTML with zero runtime (the Astro-like static path).

| File | What it does |
|---|---|
| `compile.ts` | The **DOM half** + the orchestrator: walks the flat node tree emitting element creation, bindings and reactive effects (interpolation, when/each, DataTable, Form), then hands the pieces to the right emit target. |
| `logic.ts` | The **behaviour half** (`Logic`): references, expressions, action statements, and the state/action/effect declarations → JS. Owns no DOM. Shares a `CompileCtx` with `compile.ts` (so `usedStores` is one Set). |
| `emit.ts` | The output **templates** — self-contained HTML, an ESM page module, an ESM store slice, a static page. The async data layer is written once here and shared by every format. |
| `helpers.ts` | Pure tables/helpers: the container→tag map, the Muten-op→JS-op map, `where()` parsing, an entity's editable fields. |
