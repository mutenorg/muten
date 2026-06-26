// emit.ts: assembles pre-computed EmitParts into the final output for each format.
// Formats: self-contained HTML, ESM page module, ESM store slice, static page.
// The data layer (dataLayer) is written once and shared by every runtime format.
// Consumed by compile.ts as the last step of the compile pipeline.

import type { EmitParts } from '#engine/shared/types.js';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

// Fine-grained signals runtime, inlined into the standalone HTML format (no bundler there).
export const RUNTIME = `// ── fine-grained signals runtime (~18 lines, no dependencies) ──
  let __current = null;   // the effect currently tracking signal reads
  let __owner = null;     // collects effects created in a scope so a keyed-list item can dispose its effects together
  let __pending = null; function __flush() { const r = __pending; __pending = null; if (r) for (const run of r) run(); } function __schedule(run) { if (!__pending) { __pending = new Set(); queueMicrotask(__flush); } __pending.add(run); } // batch render effects → one run per tick
  function signal(value) {
    const subs = new Set();
    return {
      get() { if (__current) { subs.add(__current); __current.deps.add(subs); } return value; },
      set(next) { if (next === value) return; value = next; for (const e of [...subs]) e.sync ? e() : __schedule(e); },
    };
  }
  function effect(fn, sync) {
    const run = () => { for (const d of run.deps) d.delete(run); run.deps.clear(); const prev = __current; __current = run; try { fn(); } finally { __current = prev; } };
    run.deps = new Set(); run.sync = sync; // sync effects (computed) run immediately on a set; render effects batch into a microtask
    const dispose = () => { for (const d of run.deps) d.delete(run); run.deps.clear(); };
    if (__owner) __owner.push(dispose);   // owned by the current scope → torn down with it
    run();
    return dispose;
  }
  function root(fn) {                       // an ownership scope: collects disposers (effects + child onCleanups); dispose() tears them ALL down (hierarchical)
    const prev = __owner, owned = []; __owner = owned;
    try { return { value: fn(), dispose() { for (const d of owned) d(); owned.length = 0; } }; }
    finally { __owner = prev; }
  }
  function onCleanup(fn) { if (__owner) __owner.push(fn); }   // register a teardown with the current owner (a keyed list disposes all its rows; a when disposes its block)
  function computed(fn) { const s = signal(fn()); effect(() => s.set(fn()), true); return s; } // derived signal (store \`get\`) — sync so reads never go stale
  function __has(a, b) { return Array.isArray(a) ? a.includes(b) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()); }
  function __eq(a, b) { if (a === b) return true; if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false; const __ka = Object.keys(a), __kb = Object.keys(b); if (__ka.length !== __kb.length) return false; for (const __k of __ka) if (a[__k] !== b[__k]) return false; return true; }
  function __lisSet(arr) { const p = arr.slice(); const result = [0]; let i, j, u, v, c; const len = arr.length; for (i = 0; i < len; i++) { const a = arr[i]; if (a !== 0) { j = result[result.length - 1]; if (arr[j] < a) { p[i] = j; result.push(i); continue; } u = 0; v = result.length - 1; while (u < v) { c = (u + v) >> 1; if (arr[result[c]] < a) u = c + 1; else v = c; } if (a < arr[result[u]]) { if (u > 0) p[i] = result[u - 1]; result[u] = i; } } } u = result.length; v = result[u - 1]; while (u-- > 0) { result[u] = v; v = p[v]; } return new Set(result); }
  function __order(parent, ref0, next, prev) { const n = next.length; if (!n) return; const pi = new Map(); for (let i = 0; i < prev.length; i++) pi.set(prev[i], i + 1); const oldIdx = new Array(n); let moved = false, max = 0; for (let i = 0; i < n; i++) { const o = pi.get(next[i]) || 0; oldIdx[i] = o; if (o !== 0) { if (o < max) moved = true; else max = o; } } const ls = moved ? __lisSet(oldIdx) : null; let ref = ref0; for (let i = n - 1; i >= 0; i--) { const e = next[i]; if (oldIdx[i] === 0 || (ls && !ls.has(i))) { for (const node of e.nodes) parent.insertBefore(node, ref); } ref = e.nodes[0] || ref; } }`;

// The data layer: a query is a reactive signal { data, loading, error }. Real `sources` fetch over
// HTTP; otherwise a mock with a small delay so loading/error states are visible. `__req`/`__rows`
// are inlined from engine/shared/source.ts so build-time SSG and runtime fetching are identical.
// Built-in pure functions: a FIXED, oracle-known vocabulary for the universal formatting needs (dates, case,
// initials, currency, truncation) so they never force a `use` escape. Inlined in every JS path (and SSR), so a
// model writes `{ago(msg.time)}` / `{initial(user.name)}` instead of hand-rolling buggy Date/string logic.
export const BUILTINS_JS = `function upper(s) { return String(s == null ? '' : s).toUpperCase(); }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  function initial(s) { return String(s == null ? '' : s).trim().charAt(0).toUpperCase(); }
  function truncate(s, n) { s = String(s == null ? '' : s); n = Number(n) || 0; return s.length > n ? s.slice(0, n) + '…' : s; }
  function money(n, cur) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(Number(n) || 0); } catch (e) { return String(n); } }
  function ago(iso) { const t = new Date(iso).getTime(); if (isNaN(t)) return String(iso == null ? '' : iso); const s = (Date.now() - t) / 1000; if (s < 45) return 'just now'; if (s < 5400) return Math.max(1, Math.round(s / 60)) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; }
  function date(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function time(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }`;

function dataLayer(parts: EmitParts): string {
  return `${BUILTINS_JS}
  const __DATA = ${JSON.stringify(parts.data)};
  const __SOURCES = ${JSON.stringify(parts.sources)};
  const __API = ${JSON.stringify(parts.api)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __DELAY = 450;
  const __loadLocal = (k, fb) => { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } };
  const __saveLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const __req = ${sourceRequest.toString()};
  const __rows = ${sourceRows.toString()};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
  function __fetch(name) { const s = __SOURCES[name]; if (s) { const q = __req(s, __API); const init = { method: q.method, headers: { ...q.headers } }; if (q.body != null) { init.body = q.body; if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(q.url, init).then((r) => r.json()).then((j) => __fill(name, __rows(j, q.at))); } return new Promise((res) => setTimeout(() => res(__fill(name, __DATA[name] ?? [])), __DELAY)); }
  function __write(name, method, id, body) { const s = __SOURCES[name]; const q = __req(s, __API); let url = q.url; if (id != null) { url = (url.charAt(url.length - 1) === '/' ? url.slice(0, -1) : url) + '/' + encodeURIComponent(id); } const init = { method: method, headers: { ...q.headers } }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(url, init).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return method === 'DELETE' ? null : r.json(); }); }
  function __refetch(name, params, sig) { const q = __req(__SOURCES[name], __API); let url = q.url; const rest = {}; for (const k in params) { const tok = '{' + k + '}'; if (url.indexOf(tok) >= 0) url = url.split(tok).join(encodeURIComponent(params[k])); else rest[k] = params[k]; } const qs = Object.keys(rest).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(rest[k])).join('&'); url = qs ? url + (url.indexOf('?') >= 0 ? '&' : '?') + qs : url; sig.set({ ...sig.get(), loading: true, error: null }); fetch(url, { method: q.method, headers: { ...q.headers } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => sig.set({ data: __fill(name, __rows(j, q.at)), loading: false, error: null })).catch((e) => sig.set({ ...sig.get(), loading: false, error: String(e) })); }   /* a {key} in the source url is filled from refetch params; the rest become the query string */
  function __send(url, method, body) { let d = { url: url, method: method }; const ci = url.indexOf(':'); if (ci > 0 && __API[url.slice(0, ci)]) d = { api: url.slice(0, ci), url: url.slice(ci + 1), method: method }; const q = __req(d, __API); const init = { method: q.method, headers: { ...q.headers } }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(q.url, init).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.status === 204 ? null : r.json().catch(() => null); }); }
  function query(name, live) { const sig = signal({ data: [], loading: true, error: null }); if (live) { let ws, tries = 0, dead = false; const open = () => { if (dead) return; const q = __req(__SOURCES[name], __API); ws = new WebSocket(q.url); ws.onopen = () => { tries = 0; }; ws.onmessage = (e) => { try { sig.set({ data: __fill(name, __rows(JSON.parse(e.data), q.at)), loading: false, error: null }); } catch { /* ignore a malformed frame */ } }; ws.onerror = () => { sig.set({ ...sig.get(), error: 'socket error' }); }; ws.onclose = () => { if (dead) return; sig.set({ ...sig.get(), loading: false }); setTimeout(open, Math.min(1000 * 2 ** tries++, 15000)); }; }; open(); onCleanup(() => { dead = true; if (ws) ws.close(); }); } else { __fetch(name).then((d) => sig.set({ data: d, loading: false, error: null })).catch((e) => sig.set({ data: [], loading: false, error: String(e) })); } return sig; }`;
}

// One .store domain slice -> shared ESM module (state + get + actions, no DOM).
export function emitStore(parts: EmitParts): string {
  return `import { signal, computed, effect, root, onCleanup, __eq, __id, __has, __order } from 'virtual:muten/runtime';
${parts.externImports}

  ${dataLayer(parts)}

${parts.stateDecls}

${parts.getDecls}

${parts.actionDecls}

${parts.effectDecls}
`;
}

// Static page (no reactivity): plain HTML, no runtime import, no signals (Astro-like zero-JS).
export function emitStatic(parts: EmitParts): string {
  return `export const screen = ${JSON.stringify(parts.screen)};
export const css = ${JSON.stringify(parts.projectCss)};
export const meta = ${JSON.stringify(parts.meta)};
export function mount(app) { app.innerHTML = ${JSON.stringify(parts.staticHtml)}; return app; }
`;
}

// SSR factory (build-time only): same pieces as emitHtml's script, but data resolves synchronously
// (mock rows, no fetch/delay) and builds into the `app` passed in instead of getElementById, so
// the build can run it against a fake DOM (see project/ssr.ts) and serialize real markup.
export function emitSsr(parts: EmitParts): string {
  return `${RUNTIME}
  ${BUILTINS_JS}
  let __seq = 0;
  function __id() { return 'id-' + (++__seq); }
  const __DATA = ${JSON.stringify(parts.data)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
  function query(name) { return signal({ data: __fill(name, __DATA[name] ?? []), loading: false, error: null }); }

  ${parts.storeDecls}

  ${parts.paramDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  ${parts.renderBody}
  return app;`;
}

// <head> tags for a page's meta: <title> + <meta name|property=...> (og:* uses property).
// Shared by both self-contained HTML formats; og:* derivation already happened at compile time.
function metaTags(meta: { [k: string]: string }, screen: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const out = [`<title>${esc(meta.title || screen)}</title>`];
  for (const name in meta) {
    if (name === 'title' || !meta[name]) continue;
    out.push(`<meta ${name.indexOf('og:') === 0 ? 'property' : 'name'}="${name}" content="${esc(meta[name])}">`);
  }
  return out.join('\n');
}

// Static page as a self-contained HTML document: pre-rendered content, no runtime, no JS (SSG).
// SEO/first-paint path for the CLI build. A page with any reactivity falls back to emitHtml (CSR).
export function emitStaticHtml(parts: EmitParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  /* project: bring-your-own-theme (Tailwind / your CSS + theme.muten vars) */
  ${parts.projectCss}
</style>
</head>
<body>
${parts.staticHtml}
</body>
</html>
`;
}

// ESM page module Vite bundles (npm imports, HMR, SPA).
export function emitModule(parts: EmitParts): string {
  return `import { signal, computed, effect, root, onCleanup, __eq, __id, __has, __order } from 'virtual:muten/runtime';
${parts.storeImports}
${parts.externImports}
export const screen = ${JSON.stringify(parts.screen)};
export const css = ${JSON.stringify(parts.projectCss)};
export const meta = ${JSON.stringify(parts.meta)};

export function mount(app, __params) {
  ${dataLayer(parts)}

  ${parts.paramDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  ${parts.renderBody}

  ${parts.effectDecls}
  return ${parts.hasSlot ? '__outlet' : 'app'};
}
`;
}

// Self-contained HTML document: runtime inlined, browser runs it directly.
export function emitHtml(parts: EmitParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  /* project: bring-your-own-theme (Tailwind / your CSS + theme.muten vars) */
  ${parts.projectCss}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
  ${RUNTIME}

  // ── dynamic ids (nothing hardcoded) ──
  let __seq = 0;
  function __id() { return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + (++__seq); }

  ${dataLayer(parts)}

  // ── app-global stores, inlined (the CLI build has no virtual modules) ──
  ${parts.storeDecls}

  // ── declared state (state from the IR) ──
  ${parts.stateDecls}

  // ── page-level derived values (get → computed) ──
  ${parts.getDecls}

  // ── actions (actions from the IR) ──
  ${parts.actionDecls}

  // ── custom components (host-written, opaque to the IR) ──
  ${parts.componentDecls}

  // ── render: imperative DOM + fine-grained effects ──
  const app = document.getElementById('app');
  app.replaceChildren(); // clear any SSR-prerendered markup before the live render takes over
  ${parts.renderBody}
</script>
</body>
</html>
`;
}
