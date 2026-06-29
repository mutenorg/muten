# Muten — Roadmap & self-audit (junio 2026)

> Where Muten loses today, and how to close the gap **without becoming React** — i.e. without abandoning
> the only thing that justifies a new framework: **an AI builds an app faster in Muten than in Astro or
> React**, because the language is small, declarative and analyzable.

## North star (the single test)
Muten is *a web UI language 100% oriented to AI*. The bet: an AI **localizes and mutates** a `.muten`
app cheaper than a React/Astro app — no huge API surface, no hidden runtime, `lint == build`, one source
of truth per concept, and the language reference **ships inside every app** (`.claude/`). Every decision
below is judged by ONE question: **does it keep the AI faster here?** If a capability only lands as a
`Custom` (vanilla-JS) hatch, the AI is back to writing framework-agnostic JS — exactly where React's
ecosystem wins. So:

> **The rule:** if the AI needs it often, it must be a **first-class, analyzable `.muten` primitive** —
> never a hatch. The hatch (`Custom`) stays only for the genuinely rare / inherently imperative (charts,
> WebGL, a 3rd-party widget).

## Where React / Vue / Angular / Astro win BY FAR (real scenarios)

| Scenario | Who wins, and why | Muten gap |
|---|---|---|
| **Public, SEO-critical site** (storefront, blog, marketing with dynamic pages) | Astro / Next: SSR/SSG/ISR + meta/OG tags + crawlable URLs | Hash routing + client render → Google sees an empty shell. **Biggest gap.** (Route params now exist — SEO is what's left.) |
| **Transactional app with a real backend** (checkout, auth, write-heavy dashboards) | React-Query / Apollo / Server Actions: mutations, optimistic, cache | `query` is **read-only**; writes fall to `Custom` `fetch`. No async actions. |
| **Rich interactive UI** (editors, builders, drag-drop, canvas, keyboard-heavy, realtime) | React/Vue + ecosystem: full events, component libs, reactive everything | 3 events (click/input/submit), **static `class()`**, `Custom` for the rest. |
| **Complex / dynamic forms** (multi-step, schema-driven, cross-field & async validation) | react-hook-form + zod / Angular Reactive Forms | auto-`Form` + `SearchField` only; richer inputs → `Custom`. |
| **Team / hiring / ecosystem** | React/Vue/Angular: npm, Stack Overflow, deep LLM training | Zero libs, zero training. *Not closed by feature parity* — see moat. |

## How to close each — as a declarative primitive (stays AI-first)

| Gap | The React/Astro way | The Muten way (analyzable, AI-fast) |
|---|---|---|
| SEO / first paint | SSR/SSG/ISR | A **build mode that pre-renders each route to HTML** — the static-HTML path already exists; the AI writes the same `.muten`, the engine renders. Add `<head>`/meta control. |
| Server writes | Server Actions / React-Query | **Async `action`s** with a declarative write op (`orders.create(form)`), not hand-rolled `fetch`. |
| Interactivity | hooks + reactive class + events | **Reactive `class(active when isOpen)`** + a fuller event set (`on(keydown: …)`) in the DSL. |
| Complex forms | rhf + zod + input libs | A **declarative field vocabulary** (date/select/file as primitives) + cross-field/async rules in the `entity` contract. |
| Ecosystem / knowledge | npm + SO + LLM training | The **shipped `SKILL.md`/`AGENTS.md`** + analyzability — the AI needs no ecosystem. *This is the moat, not a gap to chase.* |

## Prioritized roadmap (impact order)

0. ✅ **Route params** (`/product/:id` + `param id`) — done. Unblocks detail pages / most real apps.
1. **SSR/SSG** — pre-render routes to real HTML at build. *In progress:*
   - ✅ **Static pages → zero-JS HTML** (content + `<title>` in the file, at the real path). Marketing,
     about, docs, static product copy are now indexable. (Reused `renderStatic`; reactive pages stay CSR.)
   - ✅ **Data-driven pre-render** — a reactive page is executed against a tiny build-time DOM
     (`engine/project/ssr.ts`) with synchronous mock data and serialized into `#app`; the runtime still boots
     for interactivity. Product lists / search results / `each` / `when` / interpolation now land in the HTML.
     (Reuses the real compiler — no parallel renderer to keep in sync. Stores / exotic `Custom` fall back to
     the CSR shell, never break the build.)
   - ✅ **Remote `sources` = complete HTTP requests** — a source is a URL or `{ url, method?, headers?, body?, at? }`.
     The semantics live in ONE place (`engine/shared/source.ts`): the build imports them (GET → fetched at build,
     baked into the HTML for SSG; non-GET → client-only, no build side-effects) and the runtime data layer inlines
     the SAME functions via `toString()`, so the two can't drift. Offline/failed fetch → client fetches at runtime
     (build never breaks). Headers ship client-side (public keys / per-user tokens, no server secrets). Verified
     against a live auth-gated server. *Reads are now complete; writes-on-events are the action side (item 2).*
   - ✅ **One backend config — `api { base, headers }`** (in `app.muten`) — every `sources` inherits the base URL
     + default headers; a relative source url joins to `base`, an absolute one overrides, source headers win on
     conflict. Define the backend ONCE, no repetition across N endpoints. Same single source (`engine/shared/source.ts`)
     used by build + runtime (inlined via `toString()`). Keyword synced to the extension highlight/LSP. Verified live.
   - ✅ **Multiple backends — named clients** — `api { shop: {…}, cms: {…} }`; a source picks one with `{ api: "shop" }`
     (no pick → the client named `default`). The flat `api { base, headers }` form = a single default client. Verified
     live with two backends (each its own base + auth) feeding one page.
   - ✅ **Real-path navigation** — history router (`location.pathname`), internal `<a>` click interception →
     `pushState`, `popstate` sync, scroll-to-top; `Link` emits real paths; guards redirect via `replaceState`.
     (Deploy: serve index.html for any path.) Verified (Link real-path compile + suite).
   - ✅ **Meta/head** — `meta { title "…" description "…" }` per page → `<title>`/`<meta>` with `og:*` auto-derived
     (one source: compile builds it; the build `<head>` + the SPA `applyMeta` both consume it). Verified.
   - ⏳ **Param-route enumeration** (one static file per id from build data) — still open.
2. ✅ **Async actions + server writes** — a source-backed list gets `create`/`update`/`delete` in an action
   (POST / PUT `/:id` / DELETE `/:id`), reusing the source's `api` base + headers; the result updates the list
   reactively and failures set the query's `.error`. Compiles to a `__write` helper that shares the same
   request builder as reads (`engine/shared/source.ts`). Verified end-to-end against a live server (action →
   POST → server id → reactive list). The action is **async** and exposes reactive `name.pending` (in-flight)
   and `name.error` for UX (`when buy.pending { … }`). Verified live: pending toggles true→false, error
   captured on a 500. **Optimistic by default** — the list changes instantly, reconciles with the server row,
   and reverts on failure (verified live: instant row + temp id → reconciled id; 500 → reverted + error).
   Unblocks transactional apps (checkout, edit, delete). **Escape hatch:** `post`/`put`/`delete "client:/path" body x`
   for non-REST APIs (interpolated url, async, `.pending`/`.error`; `mutates` optional for pure commands). Verified live.
3. ✅ **Reactive `class()` + general events** — `class(active when cond)` compiles to a `classList.toggle`
   effect; `on(event: action)` works on any element (keydown/mouseenter/change/blur/…) via `addEventListener`
   (one `genDynamics` helper, no scatter). A `/404` route catches unmatched paths. Verified (compile + suite).
   ⏳ still open: active-link highlighting (router current-path signal), richer inputs.
4. **Forms/inputs vocabulary + richer validation** — declarative fields; cross-field/async rules.
5. **Query-strings / refetch** ✅ — `products.refetch(q: term, page: n, …)` in an action re-runs a query with N
   url-encoded params (search / pagination / filters), updating its signal. Verified live. *(Nested layouts +
   keyed `each` still open.)*

## The moat — protect AND grow it (this is *why* the AI is faster here)

- **`lint == build`** — the AI's feedback loop is truthful (no false greens). *Protect with regression tests.*
- **One source of truth per concept** (manifest / vocab) — the AI reads one place. *Protect.*
- **Analyzability** — structure (`style()` tokens) is machine-readable. *Grow it:* lift color/radius/shadow
  into tokens (closes the "look isn't analyzable" gap) so `class()` becomes the escape, not the default.
- **Shipped AI context** (`.claude/` in every app) — the AI is never untrained. *Grow + keep in sync.*
- **Minimal surface** — a small DSL fits in the model's head. *Protect:* resist feature-bloat; every new
  primitive must earn its place and stay declarative.

> The strategic line in one sentence: **don't chase React's ecosystem — make the AI not need one.** You
> beat React-for-AI not with more libraries, but because the AI writes correct Muten first-try (small +
> analyzable + context ships with the app). Add capability only as declarative primitives; the day a
> common need works *only* through `Custom`, that ground is ceded back to React.

## Compiler cleanliness — unconditional dead-code emission (noted 2026-06-29, via the playground JS tab)

A counter that uses only `signal` + `effect` compiles to a ~10 KB module dragging in code it never references.
The emitter ships a FIXED payload regardless of what the page uses. Three spots, all in `compile/emit.ts`:

1. **All 24 builtins, always.** `dataLayer()` (emit.ts:68) prepends the full `BUILTINS_JS`
   (`upper/lower/initial/truncate/money/ago/date/time/now/before/after/datetime/weekday/calendar/isToday/isPast/isFuture/daysUntil/dayKey/addDays`).
   The counter uses **zero**.
2. **The whole data layer, always.** `dataLayer()` also emits
   `__DATA/__SOURCES/__API/__UUIDS/__DELAY/__loadLocal/__saveLocal/__req/__rows/__fill/__fetch/__write/__refetch/__send/query`
   even when the page has **no** sources, queries, writes, or persisted state.
3. **All 9 runtime imports, always.** `emitModule`/`emitStore`/`emitHtml` hardcode
   `import { signal, computed, effect, root, onCleanup, __eq, __id, __has, __order }`. The counter uses `signal` + `effect`; the other 7 never.

**Impact.** The **vite/module** path is fine: esbuild/rollup tree-shake the dead locals + unused imports, so shipped
bundles stay ~2.5 KB (the headline number holds). BUT:
- The **standalone HTML / SSG** path (`emitHtml`, also the playground Result iframe) has **no bundler** → all of it
  **ships** in every static page. Real bloat for `muten build` zero-JS pages.
- The **playground JS tab** shows the raw, dirty module — a bad look for the language's own showcase.

**Fix — usage-based emission.** Make the three payloads conditional on what the doc actually references:
1. Walk the doc's exprs for called builtin names (incl. transitive deps: `calendar→time/date`) → emit only those.
2. Emit the data layer only if the doc has `sources` / `query` state / writes / `persist`; split it so a fetch-only
   page doesn't also get `__send` / live-`query` / etc.
3. Compute the runtime import set from the emitted body (`signal`/`effect` near-always; `computed` only with `get`,
   `onCleanup` only with live `query`, `__order`/`__has`/`__eq`/`__id` only where used).

NOT a correctness bug (bundled output is already pruned) — it's a cleanliness + standalone-size bug. `BUILTINS_JS`
being "inlined in every JS path" is currently deliberate (emit.ts:44-46); this revisits that for the no-bundler paths.
