# muten runner — a build tool that understands muten (study + plan)

> Status: **study / direction.** The thesis: muten already owns the hard half of a bundler (the compiler +
> the oracle). What's left is the generic web plumbing — and we don't reinvent that, we **embed esbuild** and
> add the muten intelligence on top. This doc maps what it entails, the problems, and a plan.
>
> **Shipped — Phase 1 done (2026-06-29):** Vite is replaced by **esbuild as a library** (`engine`-driven, in
> `src/esbuild-muten.ts`). `muten dev` (own HTTP server + esbuild incremental + SSE full-reload) and
> `muten bundle` (esbuild build → per-route chunks + CSS) are the **default**; `--vite` is the legacy fallback.
> The muten plugin logic (compile + oracle + virtual modules + `~/`/`/src/` roots + theme + Tailwind) is wired
> to esbuild's `onResolve`/`onLoad`; the TS compiler stays the single source of truth. **Tailwind v4** runs
> in-process via `@tailwindcss/node` + `@tailwindcss/oxide` (resolved from the app, scanning `.muten` for
> class tokens). Verified: the Tailwind site builds **and renders** on esbuild, zero Vite; dist is a touch
> smaller (CSS −5KB, JS −4KB — no Rollup wrapper). esbuild is muten's own dep; the app no longer needs Vite.
>
> CSS is built as its own artifact (sass → theme → Tailwind), outside esbuild's graph, so a new `class()` in a
> `.muten` always re-runs Tailwind's scan in dev. **CSS, SCSS (via `sass`), and Tailwind v4 all work**; bundle
> emits per-route chunks + source maps + content-hashed CSS. Verified end-to-end (headless render) on plain
> CSS, SCSS, and the Tailwind site, dev + bundle. `--vite` remains only for custom Vite/PostCSS plugins. The
> esbuild bundle is CSR (the zero-JS SSR/prerender path stays in `muten build`, the SSG — unchanged).
>
> Before this: the config moved to `muten.config` (muten syntax; `styling {}` = the theme adapter) and the app
> stopped shipping `vite.config`.

## North star
A single-binary tool that **understands a muten app** — not to bundle generic JS faster, but to make a muten
app faster, smaller, and more legible to an AI. The build *is* the oracle; the output is minimal **by
construction**, not by post-hoc tree-shaking.

## Non-goals (the lines we don't cross)
- **npm / node_modules never disappears.** Closing the bundler to npm closes muten to the world. node_modules
  stays — the difference is it should hold **only what the app actually needs to run** (the escapes' deps), not
  the 200 MB toolchain zoo. Using the muten runner does **not** mean dropping npm/yarn; they keep existing.
- **We do NOT reimplement JS/CSS compilation, minification, or node_modules resolution.** esbuild already knows
  that; we take it. The day someone says "let's write our own minifier/resolver" → no. That's becoming Rollup,
  which betrays the thesis.
- **We do NOT port the compiler off TypeScript.** The TS compiler is the single source of truth that makes
  `lint == runtime` true (one resolver, `engine/ir/refs.ts`). A Rust/Go port = two implementations = the exact
  drift the project fought to close. The compiler stays TS.

## What the toolchain does for a muten app TODAY
From `vite-plugin-muten.ts`, the split is already clear:

| muten already owns (the hard part) | Vite/Rollup/esbuild provides (the plumbing) |
|---|---|
| `.muten` → ESM (`compileModule`), `.store` → slice, shell, boot module | the dev server (HTTP, module serving) |
| the **live oracle** (`validate` in `transform`, with code-frame + did-you-mean) | the module graph + HMR transport (ws) |
| virtual modules (`virtual:muten/runtime\|shell\|store/*`) | **node_modules resolution** (for `use`/`Custom`/islands) |
| `theme.muten` → CSS vars, `~/` absolute paths, icon inline, usage-based emission | **Rollup production build** (chunking, hashing, minify) |
| routing/guards wiring, SSG (`build.ts`) | CSS/Tailwind processing, asset loaders, source maps |

So a "muten runner" replaces the **right column** with **esbuild**, keeps the **left column** as-is, and adds
the muten-aware superpowers the generic tool can't do.

## The key architectural decision: follow Bun's PHILOSOPHY, applied to muten's core
Bun's philosophy is all-in-one, native, one binary, cohesive (no glue between tools). We follow it — but
correctly: **Bun rewrites the JS toolchain because the JS toolchain IS Bun's product (a faster Node).** muten's
product is the muten language's cohesion for AI, NOT generic JS bundling — and generic JS bundling gains nothing
from understanding muten (`date-fns` is `date-fns`). So rewriting a JS bundler would be doing *Bun's* job, not
muten's: years reinventing a slower esbuild on the part that isn't our value. (Note: even Bun doesn't rewrite the
*packages* — it runs `svelte-compiler`/`date-fns`; it rewrites the *tooling*, because tooling is its product.)

Correct application: **muten owns its core natively and cohesively** (compile + oracle + dev-server + HMR +
manifest), and treats JS/CSS bundling + node_modules as a **subroutine**.

So the runner is **muten's own tool that CALLS a bundler as a library** — not "muten as a guest plugin inside
esbuild." muten owns the dev server, the HMR (by node id), the oracle loop, the manifest (Bun-style ownership);
the JS/CSS bundler is the function it invokes for the escapes' deps. That ownership is what unlocks the
superpowers (surgical HMR, AI manifest) — a guest plugin can't.

**Concretely, build ON Bun:** Bun's runtime + Bun's bundler + `bun build --compile` → one binary. muten puts the
muten-aware layer on top. We adopt Bun's tooling *and* its philosophy, without rewriting the commodity. (esbuild
is the fallback bundler-as-library if not on Bun.) The compiler stays TS (single source of truth); the binary
embeds the JS runtime + the bundler. No Node toolchain on the user's machine.

> The line: Bun owns the JS toolchain because that's Bun. muten owns the **muten** toolchain because that's
> muten. Both own their core, native and cohesive. muten just doesn't pretend its core is generic JS bundling.

## The muten-aware superpowers (the whole point)
Things a generic bundler structurally cannot do, because it sees an import graph, not a muten app:

1. **The oracle IS the build loop, live.** The runner owns the compile, so it runs the oracle on every keystroke
   and the result *is* the build result → `lint == bundle` (not just `lint == runtime`). Shown in the app, with
   the code-frame, before you save. No separate `muten check`, no stale extension.
2. **Minimal by construction.** The compiler already knows each route's exact closure (stores, parts, builtins,
   icons, the `class()` values used). The runner emits that minimum **per route, deterministically** — no
   Rollup chunk-wrapper boilerplate, dead-CSS dropped by the used class vocabulary. esbuild never has to guess.
3. **Reactivity reconciliation at build time.**
   - **IR-HMR (surgical):** recompile one page, patch the exact node by **id** in the live app via the signal
     graph — no full reload, state survives. (Today it's a blunt `full-reload`.)
   - **AOT reactivity (deep, optional):** the runner knows which signals each effect reads, so it could compile
     the dependency graph instead of tracking it at runtime → a smaller, faster runtime (Svelte-5-style). Only
     possible because the bundler understands muten.
4. **AI-oriented.** The build produces the **app graph** (routes, stores, parts, what each uses — `muten map`
   starts this) the agent reads to navigate/mutate without reading the repo. Deterministic, regular output →
   clean diffs. Structured diagnostics (not text). A **programmatic API** the model drives ("build", "give me
   the graph", "what did I break") — this is the engine of the Tauri **local-model desktop builder**:
   self-contained, no Node toolchain, oracle live, the model talks to the runner.

## Why the shipped JS gets smaller (honest accounting)
- **Pure-muten code shrinks:** no Rollup module-wrapper overhead, per-route exact closure (the usage-based
  emission goes native + per-route), dead-CSS by used `class()`, and — if we do it — a leaner AOT runtime.
- **The escape deps do NOT magically shrink:** a `use`/`Custom`/island that pulls `date-fns` still ships
  `date-fns`, tree-shaken by esbuild (same as Rollup). The win there is the **node_modules stays minimal** (only
  the app's real deps), not that the chunk vanishes.
- Net: the framework/runtime/page bytes drop; the third-party-escape bytes are bounded by esbuild — honest, not
  a free lunch.

## Problems we will face (and the call on each)
1. **Single binary vs TS compiler** — *solved by not porting.* Keep the compiler TS, embed esbuild via its API,
   compile the runner to one executable with Bun-compile / Node SEA. node_modules for the *app* still exists
   (esbuild resolves it) but holds only the app's deps.
2. **HMR depth** — surgical IR-HMR needs a client patch protocol + runtime support (apply a node-id diff). Hard.
   **Plan: start with full-reload (parity with today), add surgical HMR in a later phase.**
3. **Tailwind / CSS** — Tailwind v4's engine (Oxide, Rust) or its Node API has to run. theme.muten → vars is
   ours (done); class scanning/generation is Tailwind's — call it as a step. Plain CSS / `:root` vars are
   trivial (we already emit them).
4. **The escapes' own compilers** — islands need the svelte/react compilers (Node packages); `Custom` needs
   node_modules for its imports. The runner **orchestrates** these (esbuild + the framework compilers), it does
   not replace them. This is the "escape gap" — handled by delegation, not reinvention.
5. **Source maps** — for the AI-debug win (map `el_nX` → `.muten` lines) we must emit + merge maps through the
   compile and esbuild. Non-trivial but additive.
6. **Production orchestration** — index.html generation, asset hashing, the chunk graph, SSG (exists in
   `build.ts`) + CSR + the static/reactive split. Mostly wiring around esbuild + the existing build.
7. **Watch + incremental** — recompile only the changed page/store (the runner has the graph; esbuild context
   gives incremental rebuilds).
8. **Maintenance surface** — tracking esbuild + Tailwind versions and their integration. Real but bounded; far
   smaller than maintaining a from-scratch bundler.

## Phased plan
- **Phase 0 — today (have it):** the TS compiler + oracle + virtual modules + SSG (`build.ts`). The Vite plugin
  is the current integration.
- **Phase 1 — `muten dev` MVP:** muten-compile as an **esbuild plugin** + `esbuild.context().serve()` for the
  dev server, watch, and live-reload. Live oracle overlay. node_modules/CSS/escapes via esbuild. Full-reload
  HMR. **This is the runner's MVP — it replaces the Vite *dev* path with esbuild.** Measure dev startup + dist.
- **Phase 2 — `muten build`:** unify CSR + the existing SSG behind esbuild build (hashing, chunking, minify).
  Per-route minimal emission native. Dead-CSS by used `class()`.
- **Phase 3 — single binary + AI manifest:** Bun-compile / Node SEA → one executable. Emit the app-graph
  manifest + a programmatic API (the desktop / local-model engine).
- **Phase 4 — surgical IR-HMR**, then **(optional) AOT reactivity.** The deep, runtime-touching wins, last.

## The one gatekeeper rule
muten contributes **intelligence** (live oracle, app graph, IR-HMR, AOT reactivity, minimal-by-construction,
AI manifest). esbuild contributes the **plumbing** (.js/.css/.ts → bytes, node_modules, minify, assets). The
line is sharp: cross it (write our own minifier/resolver, or port the compiler) and we become Rollup with worse
docs and re-open the lint≠runtime drift. Stay on our side and the runner is the first bundler whose *purpose*
is to understand a muten app.
