
<img width="157" height="157" alt="Group 21" src="https://github.com/user-attachments/assets/fe9a02e6-483d-4788-9286-142c1ddb7057" /> 
<br/>

## ALPHA - STILL ON DEVELOPMENT
Muten is still under active development. We are currently in the alpha stage and are working on training models with Muten. Please keep in mind that improvements are being made gradually, and version 1.0 has not been released yet.

An **AI-first** frontend framework. You write `.muten` files; muten compiles them to vanilla JS
with fine-grained signals - **no virtual DOM, no framework runtime to ship**. The language is small,
semantic and analyzable on purpose: an AI (or a person) can **locate and mutate** an app cheaply.

```sh
npm create muten@latest my-app   # scaffold a new app (cross-platform: Windows + macOS)
cd my-app && npm install && npm run dev
```

## What a page looks like

One file, declarative, no imports or boilerplate. This is the whole thing:

```
screen home

entity Product {
  name  text
  price number
}

state {
  products = [] : list<Product>
  draft    = {} : Product
}

action add mutates products, draft <- p {
  products.push({ name: p.name, price: p.price })   # build a record inline
  draft.reset()                                     # then clear the form
}

Page class("flex flex-col gap-4") {
  Form bind(draft) submit(add) "Add product"

  each products.sortDesc by price as p {             # render the list, sorted
    Text "{p.name} - ${p.price}"
  }

  Text "Total: ${products.sum by price}"             # a live aggregate, no JS
}
```

No `useState`, no component tree, no build wiring, and `muten check` validates every reference and type before
it ever runs in a browser.

## Why muten

For an AI the cost of working on a codebase is **context + mistakes + edit-radius**. muten is built to cut
all three *by construction* - these are properties of how it compiles, not marketing:

- **Almost nothing to ship**: no virtual DOM, no framework runtime. The same todo app ships a small fraction of
  the JS the big frameworks do, and a static page ships *zero*. (See the size table in *muten vs React / Vue /
  Svelte* below.)
- **A deterministic oracle**: `muten check --json` validates every page at compile time (unknown
  state/action/part, bad style token, illegal mutation, a non-list fed to `each`/`DataTable`, a self-referential
  `get`, a constraint on the wrong field kind, a `match` arm outside its enum, `when <list>` that's always
  truthy, `every Ns` polling that never runs) in milliseconds, no browser - a feedback loop the others don't
  have. A *bounded* language is what makes that possible.
- **The whole app as data**: `app.map.json` is a compact index of routes + structure an agent reads first,
  instead of grepping a component tree.
- **Small edit radius**: the UI is declarative, so a change is usually a few lines in one file.

The trade is deliberate: a small, analyzable language an AI can hold in its head, not a general-purpose one it can't.

## muten vs React / Vue / Svelte - the honest version

They are general-purpose: they build *anything*, with mature ecosystems and a deep talent pool. **For a human team
building a big, bespoke product, that is usually the right call.** muten makes the opposite trade on purpose, and it
only wins on its own terms:

| | muten | React / Vue / Svelte |
|---|---|---|
| **Best for** | an **AI** builds & maintains it; the declarative 80% (CRUD, dashboards, content, internal tools) | human teams, large bespoke UIs |
| **Language surface** | small - the whole thing fits in an AI's context | large (hooks, lifecycle, reactivity rules) |
| **Catches mistakes** | `muten check` - at **compile time**, in milliseconds, no browser | at runtime / in tests |
| **A typical change** | a few lines in one file | ripples across components |
| **Ships to the browser** | ~2.8 KB gzip for a todo app - a static page ships **zero** | 14-59 KB of runtime + your app |
| **Ecosystem / maturity** | young · one maintainer · **pre-1.0** | mature · huge |

The single biggest reason AI-written muten works on the *first* try more often is that middle row: **a compiler that
answers before the browser does.**

**The honest cost:** muten is small by design, so it can't express everything. It shines when an **AI builds and
maintains the app** and the app is the declarative 80%. It is **not** the tool for a hand-crafted, highly-custom UI
that needs the full React ecosystem, and it doesn't pretend to be.

> **Rule of thumb:** let muten do the structure and the data; couple in other tech for the rest (next section).

## Capabilities

| Area | What you get |
|---|---|
| **UI** | declarative primitives (layout, text, forms, tables, links) · `when`/`each` control flow · `class("…")` is the single styling path - layout AND look (reactive: `class(active when isOpen)`) · `on(event: action)` on any element · **`on(enter: action)`** synthetic event on inputs (fires only on Enter key - no Custom needed for Enter-to-submit): `SearchField bind(draft) on(enter: send)` |
| **State** | local `state` · app-global `store` · derived `get` · `action`s with `if/else` · fine-grained signals. A page action can **call a store action** (`cart.add(d)  draft.reset()`): store + local work in one handler |
| **Lists** | bounded ops, no raw `map`/`reduce`: inline objects (`push({…})`) · in-place `patch` · filtered `each…where` · aggregates `sum`/`count`/`avg`/`min`/`max` · `sort`/`sortDesc` |
| **Forms** | a `Form` auto-built from an entity, one input per field: `text` · `number` (coerced) · `email` · `bool` (checkbox) · `enum` (select), with built-in validation |
| **Data** | `query` states over `sources` (full HTTP: method, headers, body, nested `at`) · one `api` block (named multi-backend clients) · optimistic CRUD (`create`/`update`/`delete` + `.pending`/`.error`) · `refetch(q: …, page: …)` · **`query x live`** (WebSocket real-time: the server pushes, only changed rows re-render) · a `post`/`put`/`delete` escape for non-REST |
| **Routing** | real-path URLs · params (`/product/:id` -> `param id`) · route guards · `/404` catch-all · route paths are **quoted strings**: `routes { "/" -> home  "/404" -> notfound }` · `Link "label" -> "/path"` · guard redirects `else "/login"` (bare paths no longer parse) |
| **SEO / SSR** | `muten build` pre-renders every route to real HTML (static pages ship zero JS; data pages fetched at build) · per-page `meta { title … description … }` with `og:*` auto-derived |
| **Interop** (lowest tier first) | `class()` for native HTML + CSS libs · `Custom` for vanilla-JS libs (charts, maps, pickers) · `use fmt from "./lib.ts"` for JS logic · **`use` functions callable as statements** inside `action` or `effect` (side effects: persist, scroll, analytics): `action send { messages.push(m)  persist(messages)  scrollBottom() }` |
| **AI-native** | `lint == build` · one source of truth per concept · the full language reference ships in every scaffolded app under `.claude/` (an AGENTS guide + a Claude skill) |

## Reactivity & reconciliation

muten is **Solid's fine-grained signals + Svelte's compile-to-direct-DOM**, with **no virtual DOM**:

- **Reads subscribe, writes notify.** Each `{count}`, `class(active when x)`, `when`, `each` compiles to its own tiny effect that reads exactly the signals it needs - when one changes, only that spot updates, never a re-render of the tree.
- **Lists reconcile by `id`** (never by index): `each`/`DataTable` keep a per-row signal, so on new data only the rows whose fields changed touch the DOM (the rest are reused or moved in place), and removed rows dispose their effects - no leaks, no zombies. Focus, scroll and input survive live updates.
- **Updates batch** into one microtask, the way Solid does: a burst of writes in a tick re-renders each spot **once**, not per write - so a real-time feed (a `live` socket) costs one render per frame, not one per message.

No diffing, no virtual-DOM memory, no framework interpreter to ship. That is what keeps muten fast as apps grow; for *huge* lists you still virtualize (render only the visible rows) and send server-side deltas, exactly as you would in any framework.

## How muten couples with the rest of the web - two tiers

muten the *language* stays tiny on purpose; a muten *app* reaches the whole web platform through **bounded,
analyzable escapes**. The point: you never *fight* the language to do something it doesn't have, you drop to the
right tier, and the compiler still checks the seam. Reach for the **lowest tier that works**:

| Tier | What it reaches | Typical examples | The trade |
|---|---|---|---|
| **1 · Pure muten** | the declarative 80% - pages, routing (params, guards, `/404`), `state`/`store`/`get`, the **list toolkit**, `Form` (+validation), `query` over REST, SSG + SEO | a whole **CRUD / SaaS / catalog / dashboard / content** app | **zero extra deps** |
| **2 · muten + the platform** | native HTML + CSS libs via `class()`, **vanilla JS via `Custom`**, JS logic via `use … from "./lib.ts"` | `<dialog>`, Tailwind/DaisyUI, chart.js, Leaflet, flatpickr, Quill, zod, date-fns | a JS dep - **no framework runtime** |

Almost every "hard widget" lands at **tier 2**. The language stays small by design; anything beyond pure muten + platform escapes lives in ordinary JS.

**Why the escapes stay safe.** The compiler validates the *seam* - the `state` props and `action` callbacks
crossing into a `Custom`, and the call site of a `use` function (an undeclared one is a `check` error). So
coupling in chart.js or zod never costs you the oracle on the muten side.

**Deploy - the honest caveat.** `muten build` (the CLI SSG) is **structure-only**: it emits plain HTML
per route but omits non-layout token CSS, the project `styles.css`, and does not bundle `use` functions
(they throw at runtime if the static build is served). For a styled, fully-runnable app use `vite build`.
`npm run dev` runs every tier regardless - this only affects the production *build*.

| Your app uses... | Deploy with |
|---|---|
| Pure muten, static content only | `muten build` (zero-JS HTML) or `vite build` |
| `use` JS functions, `Custom`, shared store, or any styling | **`vite build`** (bundles everything; the static build doesn't) |

**Most real apps use `vite build`.**

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
  "/" -> home
  "/404" -> notfound
}
```

## CLI

```sh
muten build [dir]            # compile → ./dist/<route>/index.html (+ app.map.json)
muten check [dir] [--json]   # parse + validate every page, no compile - the deterministic ORACLE
                             #   --json → structured diagnostics (code + loc + "did you mean…?") in ms, no browser
muten map   [dir] [--json]   # emit app.map.json COLD (no build) - the app graph an AI reads FIRST
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

The source is TypeScript under `src/`, organized by **domain**: each has its own README:

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
(modules preserved, so nothing bundles into a heavy monolith). `dist/` is generated - edit `src/`.

## Styling & escape hatch

muten imposes no theme. There is ONE way to style: `class("…")` (your CSS / Tailwind / anything) carries both
layout and look — and it composes reactively: toggle a token (`class(active when x)`) or build one from a value
(`class("status-{m.status}")` → `status-online`/`status-idle`, the reference oracle-checked). `theme.muten` holds
the design values and muten emits them as `:root` CSS custom properties (`--space-md`, `--color-primary`, ...)
that your CSS consumes. For a CSS value that **changes at runtime** (a progress width, a dynamic transform),
`style(w: "{pct}%")` binds it to a CSS variable `--w` (the only thing `style()` can set). Common formatting is
**built in** — `ago` / `date` / `time` / `initial` / `money` / `upper` / `truncate` (no `use` for dates or
initials). For behavior the primitives can't express, drop to a `Custom` component (`src/components/<Name>.js`).

## Status & roadmap (honest)

**Pre-1.0 - the core is solid, the edges are young.** Build real apps with it; don't bet a critical
production system on it yet (small ecosystem, one maintainer, not yet battle-tested).

**Solid today:** the language + compiler, the `check` / `build` / `map` CLI + oracle, the Vite plugin + dev
server + HMR, the VS Code extension (live-lint + autocomplete).
The bounded list toolkit - inline objects, `patch`, `each...where`, aggregates (`sum`/`count`/`avg`/`min`/`max`),
`sort`/`sortDesc`, and page->store action composition, so a real CRUD/dashboard app is pure muten, no JS escape.
`Form` fields cover `text` · `number` (coerced) · `email` · `bool` (checkbox) · `enum` (select), with validation.
Reactivity is keyed and batched: `each`/`DataTable` reconcile rows by `id` with minimal DOM moves, and `query x live`
streams real-time updates over a WebSocket (only changed rows re-render).

**Next, toward 1.0:**
- a `date`/`textarea` `Form` field type; number formatting (`round` / currency) in expressions.
- built-in virtualization for huge lists (today you render only visible rows yourself).
- richer SSG for stateful multi-page apps (today a shared `.store` across pages deploys via `vite build`, not the
  static `muten build`).

**By design (the moat, not a bug):** muten is declarative + bounded. The list toolkit (`patch` · `sort` · the
aggregates · `each...where`) gives the *common* list jobs without exposing raw `map`/`reduce` - anything past that
(an arbitrary transform) is a `use` JS function, and a real framework widget is a tier 2/3 escape. The ceiling is
what keeps it small and analyzable; closing it would just make another general-purpose framework.

## Limitations / not yet

These are honest gaps found during stress-testing. They are known and tracked; none are design mistakes, just things not built yet.

**Build tooling**
- `muten build` (CLI SSG) is structure-only: it omits non-layout token CSS, the project `styles.css`, and does not bundle `use` functions (they throw). Use `npm run dev` for development and `vite build` for production in any real app.

**Language features not yet available**
- No `match`/`switch`: use N separate `when` blocks per enum value.
- `sort by` takes a literal field name, not a variable.
- `query x live` (WebSocket) requires the server to send an `id` per row for keyed diffing; without it, reconciliation falls back to full re-render.

**DataTable**
- Renders raw cell values only; no per-column formatting yet. For formatted cells, use `each` with a `Part`.

**Form**
- Auto-generates one input per entity field; no conditional fields.
- Enum fields cannot be marked `required`.
- Field types are limited to `text`, `number`, `email`, `bool`, `enum`. No `password`, `date`, or `textarea` yet - drop to a `Custom` component for those.
- `Form` renders all entity fields; there is no way to exclude a subset without a `Custom`.

**Select / dropdown outside a Form**
- No standalone `Select` primitive. A `Form` auto-generates one for enum fields; outside a `Form`, build a button group with `each` + `on(click:)`.

**Custom inputs**
- A `Custom` component receives a snapshot of state at mount. To keep it reactive, pass state references with `@` props and manage updates inside the component.

**No design-system escape hatch yet**
- `class()` passes through arbitrary CSS class names, but there is no component-level slot system for composing muten primitives inside a `Custom`.
