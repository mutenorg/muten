// Emit targets: assemble the pre-computed pieces (an EmitParts) into the final output of each
// format — self-contained HTML, an ESM page module, an ESM store slice, or a static page.
// The async data layer is written ONCE here (dataLayer) and shared by every runtime format.

import type { EmitParts } from '#engine/shared/types.js';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

// the fine-grained signals runtime, inlined into the standalone HTML format (no bundler there).
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
  function __eq(a, b) { if (a === b) return true; if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false; const __ka = Object.keys(a), __kb = Object.keys(b); if (__ka.length !== __kb.length) return false; for (const __k of __ka) if (a[__k] !== b[__k]) return false; return true; }`;

// The data layer: a query is a RICH reactive signal { data, loading, error }. Real `sources` fetch over
// HTTP (the full request — method/headers/body); otherwise a mock with a small delay so loading/error are
// visible. `__req`/`__rows` are inlined from engine/shared/source.ts (the SAME functions the build uses)
// so build-time SSG and runtime fetching are byte-for-byte identical.
function dataLayer(parts: EmitParts): string {
  return `const __DATA = ${JSON.stringify(parts.data)};
  const __SOURCES = ${JSON.stringify(parts.sources)};
  const __API = ${JSON.stringify(parts.api)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __DELAY = 450;
  const __req = ${sourceRequest.toString()};
  const __rows = ${sourceRows.toString()};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
  function __fetch(name) { const s = __SOURCES[name]; if (s) { const q = __req(s, __API); const init = { method: q.method, headers: { ...q.headers } }; if (q.body != null) { init.body = q.body; if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(q.url, init).then((r) => r.json()).then((j) => __fill(name, __rows(j, q.at))); } return new Promise((res) => setTimeout(() => res(__fill(name, __DATA[name] ?? [])), __DELAY)); }
  function __write(name, method, id, body) { const s = __SOURCES[name]; const q = __req(s, __API); let url = q.url; if (id != null) { url = (url.charAt(url.length - 1) === '/' ? url.slice(0, -1) : url) + '/' + encodeURIComponent(id); } const init = { method: method, headers: { ...q.headers } }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(url, init).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return method === 'DELETE' ? null : r.json(); }); }
  function __refetch(name, params, sig) { const q = __req(__SOURCES[name], __API); const qs = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&'); const url = qs ? q.url + (q.url.indexOf('?') >= 0 ? '&' : '?') + qs : q.url; sig.set({ ...sig.get(), loading: true, error: null }); fetch(url, { method: q.method, headers: { ...q.headers } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => sig.set({ data: __fill(name, __rows(j, q.at)), loading: false, error: null })).catch((e) => sig.set({ ...sig.get(), loading: false, error: String(e) })); }
  function __send(url, method, body) { let d = { url: url, method: method }; const ci = url.indexOf(':'); if (ci > 0 && __API[url.slice(0, ci)]) d = { api: url.slice(0, ci), url: url.slice(ci + 1), method: method }; const q = __req(d, __API); const init = { method: q.method, headers: { ...q.headers } }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(q.url, init).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.status === 204 ? null : r.json().catch(() => null); }); }
  function query(name, live) { const sig = signal({ data: [], loading: true, error: null }); if (live) { const q = __req(__SOURCES[name], __API); const ws = new WebSocket(q.url); ws.onmessage = (e) => sig.set({ data: __fill(name, __rows(JSON.parse(e.data), q.at)), loading: false, error: null }); ws.onerror = () => sig.set({ ...sig.get(), loading: false, error: 'socket error' }); onCleanup(() => ws.close()); } else { __fetch(name).then((d) => sig.set({ data: d, loading: false, error: null })).catch((e) => sig.set({ data: [], loading: false, error: String(e) })); } return sig; }`;
}

// one .store DOMAIN slice → shared ESM module (state + get + actions, no DOM).
export function emitStore(parts: EmitParts): string {
  return `import { signal, computed, effect, root, onCleanup, __eq, __id, __has } from 'virtual:muten/runtime';
${parts.externImports}

  ${dataLayer(parts)}

${parts.stateDecls}

${parts.getDecls}

${parts.actionDecls}

${parts.effectDecls}
`;
}

// a static page (no reactivity): plain HTML, NO runtime import, NO signals (Astro-like zero-JS).
export function emitStatic(parts: EmitParts): string {
  return `export const screen = ${JSON.stringify(parts.screen)};
export const css = ${JSON.stringify(`${parts.tokenCss}\n${parts.projectCss}`)};
export const meta = ${JSON.stringify(parts.meta)};
export function mount(app) { app.innerHTML = ${JSON.stringify(parts.staticHtml)}; return app; }
`;
}

// SSR factory (build-time only): the same pieces as emitHtml's script, but data resolves SYNCHRONOUSLY
// (mock rows, no fetch/delay) and it builds into the `app` it's handed instead of getElementById — so the
// build can run it against a fake DOM (see project/ssr.ts) and serialize real markup for a reactive page.
export function emitSsr(parts: EmitParts): string {
  return `${RUNTIME}
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

// the <head> tag set for a page's meta: <title> + <meta name|property=…> (og:* uses property). Shared by
// both self-contained HTML formats; the og:* derivation already happened at compile (one source, no DRY).
function metaTags(meta: { [k: string]: string }, screen: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const out = [`<title>${esc(meta.title || screen)}</title>`];
  for (const name in meta) {
    if (name === 'title' || !meta[name]) continue;
    out.push(`<meta ${name.indexOf('og:') === 0 ? 'property' : 'name'}="${name}" content="${esc(meta[name])}">`);
  }
  return out.join('\n');
}

// a static page as a self-contained HTML document — pre-rendered content, NO runtime, NO JS (SSG).
// The SEO/first-paint path for the CLI build: crawlers and the browser get real markup at the real URL,
// not an empty #app filled by script. A page with any reactivity falls back to emitHtml (CSR) instead.
export function emitStaticHtml(parts: EmitParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  /* engine: only the used tokens */
  ${parts.tokenCss}
  /* project: bring-your-own-theme */
  ${parts.projectCss}
</style>
</head>
<body>
${parts.staticHtml}
</body>
</html>
`;
}

// an ESM page module Vite bundles (npm imports, HMR, SPA).
export function emitModule(parts: EmitParts): string {
  return `import { signal, computed, effect, root, onCleanup, __eq, __id, __has } from 'virtual:muten/runtime';
${parts.storeImports}
${parts.externImports}
export const screen = ${JSON.stringify(parts.screen)};
export const css = ${JSON.stringify(`${parts.tokenCss}\n${parts.projectCss}`)};
export const meta = ${JSON.stringify(parts.meta)};

export function mount(app, __params) {
  ${dataLayer(parts)}

  ${parts.paramDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  ${parts.renderBody}
  return ${parts.hasSlot ? '__outlet' : 'app'};
}
`;
}

// a self-contained HTML document (the runtime is inlined; the browser runs it directly).
export function emitHtml(parts: EmitParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  /* engine: only the used tokens — no base styles (those are the project's stylesheet) */
  ${parts.tokenCss}
  /* project: overrides the above via the cascade (bring-your-own-theme) */
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
