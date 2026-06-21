# project — filesystem & whole-app awareness

The only domain that touches the disk. Everything else is pure (text → IR → Doc → string); here is
where a single page becomes a real, project-aware build, and where the editor's smart linting lives.

| File | What it does |
|---|---|
| `load.ts` | A page → everything needed to compile it: parse, gather + compose parts (shared + local + inline), hoist the used parts' entity/state/mock, gather styles, flatten. |
| `analyze.ts` | The project-aware analyzer behind the live linter/autocomplete: loads all parts, hoists their state so `@refs` validate for real, knows the store domains + theme. Consumed by the VS Code extension and the CLI. |
| `routes.ts` | Reads `src/app.muten` → the route table (the app root); throws on a missing/duplicate/dangling route. |
| `styles.ts` | Resolves a page's colocated stylesheet (`.css`, or `.scss` via the optional `sass` dependency). |
