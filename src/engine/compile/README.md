# compile - the back-end (Doc → runnable JS)

The thesis made concrete: **no virtual DOM**. It emits imperative DOM construction plus fine-grained
`effect`s that touch only what the changed state feeds. A page with no reactivity at all compiles to
plain HTML with zero runtime (the Astro-like static path).

| File | What it does |
|---|---|
| `compile.ts` | The orchestrator: builds the page's `Emitter` (the helpers every generator shares, types-compile.ts), walks the flat tree, dispatches each node to its family's generator through one table (`NODE_EMITTERS`), handles containers, text, `when`/`each` and the shell, then hands the pieces to the right emit target. |
| `fields.ts` | The standalone inputs: SearchField, Textarea, Password, Select, Checkbox, Date, Number, Range. Two-way bound, named by their own text. |
| `svg.ts` | The vector layer (Svg, Group, Rect, Line, Circle, Path, Arc) and Chart on top of it. |
| `tables.ts` | List, Table, Row, Cell, Details, DataTable: the structural blocks with native semantics. |
| `media.ts` | Image (lazy, safe src), Icon (inline SVG; from data, only the names the page spells out), Video. |
| `controls.ts` | Button (always `type=button`) and Link (router navigation, born active, truly disabled). |
| `custom.ts` | A `Custom` node: a host widget, a Web Component, or a React island (`use element|widget|react`). |
| `form.ts` | A `Form` over an entity draft: labelled field groups, native constraint attributes, muten's checks in the page's language. |
| `dynamics.ts` | What any element may carry: id, reactive classes, events, drag/drop, aria/data, `disabled`, `style()` variables. |
| `static.ts` | The zero-JS half: which subtrees are static, and the HTML they render to (a static page, or a `__clone` template). |
| `logic.ts` | The behaviour half (`Logic`): refs, expressions, action statements, state/action/effect declarations. Owns no DOM. |
| `emit.ts` | The output templates (HTML, ESM page, store slice, static page, HMR patch) and the data layer; built-ins are emitted as `__b_<name>`. |
| `foreign.ts` | The module import a `use` line becomes (functions, Web Components, widgets, React). |
| `guard.ts` | A route guard expression → the JS the router (or a `muten build` page) checks. |
| `sourcemap.ts` | A node-granularity source map: a runtime error points at the `.muten` line. |
| `helpers.ts` | Pure tables/helpers: the container→tag map, the op→JS-op map, `where()` parsing, an entity's editable fields. |
