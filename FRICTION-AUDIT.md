# muten — friction audit (dogfood corpus, 2026-07)

Record of every place a **fresh AI** (qwen3-coder, via the `builder/` desktop app driving local Ollama models)
diverged from muten while building real apps (charity landing, "Pulse" SaaS landing). Kept so we can later **prune
the language**: delete what only causes errors, keep what earns its cost.

## The core finding (why simple pages cost a lot)

A simple landing page took ~5 iterations + a dozen engine fixes to go green. **This is NOT because muten is complex —
it's because muten is UNFAMILIAR.** Every model knows JS/React/Vue/HTML cold and has never seen muten. So it writes
its host-language idioms and muten rejects each one. **The cost of a page ≈ the number of JS-idiom divergences it
hits**, not its structural complexity.

So the lever for "make simple pages easy" is: **minimize GRATUITOUS divergence from JS; keep a divergence ONLY when
it earns the oracle / AI-locatability / the closed escape.** The audit question for every rule below:

> Does this divergence from JS EARN its cost (enables the oracle to analyze, keeps data locatable, closes the escape),
> or is it gratuitous friction the model pays for nothing?

## Legend
- **KEEP** — earns its cost; the divergence is the value. Teach it with a located error that names the fix.
- **TOLERATED** — was gratuitous friction; muten now accepts the JS-ish form (done this pass).
- **AUDIT** — candidate: maybe gratuitous, consider tolerating/aligning with JS.
- **GAP** — muten LACKS something the model reasonably needed; consider adding.

## Ledger — what the model wrote vs. what muten wanted

| The model wrote (JS/React idiom) | muten wants | Status | Earns its cost? |
|---|---|---|---|
| `// …`, `/* … */` comments | `# …` | **TOLERATED** (lexer) | No — comments are non-semantic. Right to accept. |
| leading UTF-8 BOM | (none) | **TOLERATED** | No — editor artifact. Right to skip. |
| `showDonate = false` (no `: type`) | `: bool` | **TOLERATED** (inferred) | No — the literal already reveals the type. Right to infer. |
| `rating number min(1) max(5)` | `min:1 max:5` | **TOLERATED** (both forms) | No — `:` vs `()` is an arbitrary choice. Consider standardizing on `min(1)`. |
| `features list<text>` (list field) | (was unsupported) | **TOLERATED** (added) | N/A — a real, common capability (tags/bullets). |
| `each [ {…} {…} ] as x` (inline list) | named `state … : list` | **TOLERATED** (hoist+infer) | Partial — data-in-state earns its cost for MUTABLE data; static content is fine inline. Boundary preserved (can't `push` to an inline list). |
| `donors.sortDesc by date take(3)` | (was unsupported) | **TOLERATED** (added) | N/A — top-N is the #1 dashboard need. |
| `.map/.filter/.orderBy/.limit/.reduce` | `where` / `sort by` / `take` / `sum\|avg\|count by` | **KEEP** (teach) | **Yes** — no arbitrary JS is the closed escape; the oracle can analyze declarative ops, not method chains. |
| `Button -> "/route"` (navigation) | `Link -> "/route"` | **KEEP** (teach) | **Yes** — semantic `<a>` vs `<button>` (accessibility, open-in-new-tab). |
| `x \| money` (Vue/Angular pipe) | `money(x)` | **KEEP** (teach) | Weak — pipes are just sugar. Divergence is minor; teaching suffices. |
| `if X then Y else Z` (expr) | `X ? Y : Z` | **KEEP** (teach) | Neutral — `? :` IS JS; model used the rarer form. |
| `\"a\"` (backslash-escaped quotes) | nested `"a"` (no escape) | **TOLERATED** (lexer) | The teaching FAILED (model stuck 6×) — escaping a quote is the most universal JS instinct. Now `\"` → literal `"`. `\d` etc. stay literal (regex safe). |
| `each … where … take(3)` (top-N of matching) | (was unsupported) | **TOLERATED** (added) | N/A — "first N matching" is a common list need; now `each x as i [where …] take(n)`. |
| `Math.round(x)`, `(x).toFixed(0)` | `money(x)` / drop | **KEEP** (teach) | **GAP underneath** — muten has no `round()`. See gaps. |
| `if …` in the tree | `when …` | **AUDIT** (teach) | Weak — `when` vs `if` is a naming choice. Consider accepting `if` for conditional rendering. |
| `when … { } else { }` | two `when`s | **AUDIT** (teach) | **Likely gratuitous** — the model naturally wants `else`. Strong candidate to ADD `when/else`. |
| `class="x"` (HTML/JSX) | `class("x")` | **AUDIT** | **Likely gratuitous** — `class="x"` is universal. Consider tolerating `attr="v"` → `attr("v")`. |
| `'single quotes'` | `"double quotes"` | **AUDIT** (teach) | Weak — JS allows both; muten could tolerate `'…'`. Weigh vs. the nested-quote lexer. |
| `Form bind(draft) submit(a) { … }` | individual inputs + `Button -> a` | **AUDIT** (teach→drop) | **Form is a trap** — every model fights it; the builder forbids it (rule 10). Strong candidate to REMOVE `Form` from the language. |
| `action f mutates { }` (empty) | `action f { }` | **KEEP** (teach) | Neutral — `mutates` with no target is meaningless; the located error is enough. |

## Gaps — muten lacks something the model reasonably reached for
- **`round(n)` / number rounding** — the model wrote `Math.round(x)` / `.toFixed(0)` for discounted prices. muten has
  `money()` but no plain rounding. **Consider a built-in `round(n)` / `round(n, dp)`.**
- **`when … else …` in the tree** — the model writes `else` constantly (star ratings, submitted/not-submitted). Forcing
  two `when`s is real friction. **Strong candidate to add `else`.**
- **A "repeat N times"** — `each [1,2,3,4,5] as i` works (tolerated inline), so this is covered.

## Recommended audit actions (prune / align, in priority order)
1. **Add `when/else`** in the tree — high-frequency, gratuitous friction.
2. **Remove `Form`** (or make it a first-class teaching-only alias) — it's a pure trap; the builder never wants it.
3. **Add `round(n)`** — closes the `Math.round`/`.toFixed` gap.
4. **Tolerate `class="x"`** (and `attr="v"` → `attr("v")`) — align with universal HTML/JSX habit.
5. **Consider tolerating `'single quotes'`** — align with JS (weigh against the nested-quote lexer).
6. Standardize constraint syntax on `min(8)` (drop the `:` form) OR keep both.

Everything under **KEEP** is the load-bearing 20% — the divergences that BUY the oracle + locatability + the closed
escape. Everything under **AUDIT / TOLERATED / GAP** is the papercut layer: that's where "simple pages cost a lot"
lives, and where the pruning should focus.
