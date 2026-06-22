
<img width="157" height="157" alt="Group 21" src="https://github.com/user-attachments/assets/fe9a02e6-483d-4788-9286-142c1ddb7057" /> </br>
An **AI-first** frontend framework. You write `.muten` files; muten compiles them to vanilla JS
with fine-grained signals — **no virtual DOM, no framework runtime to ship**. The language is small,
semantic and analyzable on purpose: an AI (or a person) can **locate and mutate** an app cheaply.

```sh
npm create muten@latest my-app   # scaffold a new app (cross-platform: Windows + macOS)
cd my-app && npm install && npm run dev
```

## Capabilities

- **UI** — declarative primitives (layout, text, forms, tables, links), `when`/`each` control flow,
  `style()` layout tokens + `class()` look (toggle reactively: `class(active when isOpen)`), events on
  any element (`on(keydown: act)`).
- **State** — local `state`, app-global `store`, derived `get`, `action`s with `if/else`; fine-grained signals.
- **Data** — `query` states backed by `sources` (full HTTP: method, headers, body, nested `at`); one `api`
  block for base URL + auth (named clients for several backends); CRUD writes (`create`/`update`/`delete` —
  optimistic, with `.pending`/`.error`); `refetch(q: …, page: …)` for search/pagination; a `post`/`put`/`delete`
  escape for non-REST APIs.
- **Routing** — real-path URLs, params (`/product/:id` → `param id`), guards, a `/404` catch-all.
- **SEO / SSR** — `muten build` pre-renders every route to real HTML (static pages ship zero JS; data-driven
  pages are fetched at build), with per-page `meta { title … description … }` (`og:*` auto-derived).
- **AI-native** — `lint == build`, one source of truth per concept, and the full language reference ships
  inside every scaffolded app under `.claude/` (an AGENTS guide + a Claude skill).

## The app, by convention

```
my-app/
├─ src/
│  ├─ app.muten            # the ROOT: routes (+ optional persistent shell)
│  ├─ pages/
│  │  └─ home/home.muten   # a page; the folder name is its route target
│  ├─ parts/               # reusable .muten components (object + action params)
│  └─ components/          # host-written Custom JS (the escape hatch)
├─ theme.muten             # the project's token scale (md=16px, breakpoints, …)
└─ src/styles.css          # the look (muten ships structure + layout; the skin is yours)
```

`src/app.muten` is the single source of truth the AI reads first:

```
routes {
  / -> home
}
```

## CLI

```sh
muten build [dir]            # compile → ./dist/<route>/index.html (+ app.map.json)
muten check [dir] [--json]   # parse + validate every page, no compile — the deterministic ORACLE
                             #   --json → structured diagnostics (code + loc + "did you mean…?") in ms, no browser
muten map   [dir] [--json]   # emit app.map.json COLD (no build) — the app graph an AI reads FIRST
```

`check` and `map` are the AI-first feedback loop: an agent asks the compiler "is this valid, and what
did I mean?" (`check --json`) and "what's the whole app?" (`map`) without running a browser. `lint` is an
alias of `check`.

`build`/`lint` default to the current directory; pass a path to target another. The `muten` bin ships
with the app (it's a dependency). To scaffold a *new* app, use `npm create muten@latest` (the separate
[`create-muten`](https://www.npmjs.com/package/create-muten) scaffolder).

## Dev server (Vite)

The Vite plugin gives a Muten app a dev server + HMR + client-side routing while authoring stays the
DSL. `npm create muten` wires it up; `npm run dev` runs it.

```js
// vite.config.mjs
import muten from '@muten/core/vite-plugin-muten.js';
export default { plugins: [muten()] };  // theme.muten is auto-loaded
```

## Programmatic API

```js
import { buildApp, compile, parse, validate, toDoc } from '@muten/core';

await buildApp('./my-app');               // same as `muten build ./my-app`
const html = compile(toDoc(parse(src)));  // drive the compiler directly (embedding)
```

## Architecture

The compiler is a straight pipeline of small, single-purpose stages:

```
.muten ─[lang]→ IR ─[ir: compose]→ tree ─[ir: flatten]→ Doc ─[ir: validate]→ ✓ ─[compile]→ JS
```

The source is TypeScript under `src/`, organized by **domain** — each has its own README:

| Domain | Role |
|---|---|
| [`src/engine/shared`](src/engine/shared/README.md) | contracts: types, the vocabulary (no magic strings), diagnostics |
| [`src/engine/lang`](src/engine/lang/README.md) | front-end: `.muten` text → IR (lexer · grammar · parser · manifest) |
| [`src/engine/ir`](src/engine/ir/README.md) | IR transforms + validation (compose · flatten · validate) |
| [`src/engine/compile`](src/engine/compile/README.md) | back-end: Doc → runnable JS (DOM + logic + emit + helpers) |
| [`src/engine/style`](src/engine/style/README.md) | the styling token vocabulary (the engine ships no values) |
| [`src/engine/project`](src/engine/project/README.md) | filesystem + whole-app awareness (load · analyze · routes · styles) |

The runtime (the only thing shipped to the browser), the Vite plugin, the CLI and the build/lint
orchestration also live in `src/`. See [`src/engine/README.md`](src/engine/README.md) for the
file-level conventions (≤500 lines, honest types, data-table dispatch, no magic strings).

## Build

`npm run build` = `tsc` (strict type-check) + `esbuild` → `dist/**/*.js`, **minified, per-file**
(modules preserved, so nothing bundles into a heavy monolith). `dist/` is generated — edit `src/`.

## Styling & escape hatch

muten imposes no theme. A page lays itself out with `style(…)` tokens (analyzable, resolved against
`theme.muten`) and skins itself via `class("…")` (your CSS / Tailwind / anything). For behavior the
primitives can't express, drop to a `Custom` component (`src/components/<Name>.js`).
