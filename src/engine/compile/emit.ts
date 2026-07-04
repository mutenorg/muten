// emit.ts: assembles pre-computed EmitParts into the final output for each format.
// Formats: self-contained HTML, ESM page module, ESM store slice, static page.
// The data layer (dataLayer) is written once and shared by every runtime format.
// Consumed by compile.ts as the last step of the compile pipeline.

import type { EmitParts } from '#engine/shared/types.js';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

// Fine-grained signals runtime, inlined into the standalone HTML format (no bundler there).
export const RUNTIME = `let __current = null;
  let __owner = null;
  let __pending = null; function __flush() { const r = __pending; __pending = null; if (r) for (const run of r) run(); } function __schedule(run) { if (!__pending) { __pending = new Set(); queueMicrotask(__flush); } __pending.add(run); }
  function signal(value) {
    const subs = new Set();
    return {
      get() { if (__current) { subs.add(__current); __current.deps.add(subs); } return value; },
      set(next) { if (next === value) return; value = next; for (const e of [...subs]) e.sync ? e() : __schedule(e); },
    };
  }
  function effect(fn, sync) {
    const run = () => { for (const d of run.deps) d.delete(run); run.deps.clear(); const prev = __current; __current = run; try { fn(); } finally { __current = prev; } };
    run.deps = new Set(); run.sync = sync;
    const dispose = () => { for (const d of run.deps) d.delete(run); run.deps.clear(); };
    if (__owner) __owner.push(dispose);
    run();
    return dispose;
  }
  function root(fn) {
    const prev = __owner, owned = []; __owner = owned;
    try { return { value: fn(), dispose() { for (const d of owned) d(); owned.length = 0; } }; }
    finally { __owner = prev; }
  }
  function onCleanup(fn) { if (__owner) __owner.push(fn); }
  function computed(fn) { const s = signal(fn()); effect(() => s.set(fn()), true); return s; }
  function __has(a, b) { return Array.isArray(a) ? a.includes(b) : String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()); }
  function __eq(a, b) { if (a === b) return true; if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false; const __ka = Object.keys(a), __kb = Object.keys(b); if (__ka.length !== __kb.length) return false; for (const __k of __ka) if (a[__k] !== b[__k]) return false; return true; }
  function __lisSet(arr) { const p = arr.slice(); const result = [0]; let i, j, u, v, c; const len = arr.length; for (i = 0; i < len; i++) { const a = arr[i]; if (a !== 0) { j = result[result.length - 1]; if (arr[j] < a) { p[i] = j; result.push(i); continue; } u = 0; v = result.length - 1; while (u < v) { c = (u + v) >> 1; if (arr[result[c]] < a) u = c + 1; else v = c; } if (a < arr[result[u]]) { if (u > 0) p[i] = result[u - 1]; result[u] = i; } } } u = result.length; v = result[u - 1]; while (u-- > 0) { result[u] = v; v = p[v]; } return new Set(result); }
  function __order(parent, ref0, next, prev) { const n = next.length; if (!n) return; const pi = new Map(); for (let i = 0; i < prev.length; i++) pi.set(prev[i], i + 1); const oldIdx = new Array(n); let moved = false, max = 0; for (let i = 0; i < n; i++) { const o = pi.get(next[i]) || 0; oldIdx[i] = o; if (o !== 0) { if (o < max) moved = true; else max = o; } } const ls = moved ? __lisSet(oldIdx) : null; let ref = ref0; for (let i = n - 1; i >= 0; i--) { const e = next[i]; if (oldIdx[i] === 0 || (ls && !ls.has(i))) { for (const node of e.nodes) parent.insertBefore(node, ref); } ref = e.nodes[0] || ref; } }
  function __chart(svg, rows, enc, legend) { rows = Array.isArray(rows) ? rows : []; const NS = 'http://www.w3.org/2000/svg'; const cs = getComputedStyle(svg); const num = (n, d) => { const v = parseFloat(cs.getPropertyValue(n)); return isFinite(v) ? v : d; }; const W = num('--chart-w', 320), H = num('--chart-h', 200), pL = num('--chart-pad-left', 38), pR = num('--chart-pad-right', 10), pT = num('--chart-pad-top', 10), pB = num('--chart-pad-bottom', 26), iw = W - pL - pR, ih = H - pT - pB, TICKS = Math.max(1, Math.round(num('--chart-ticks', 4))), BARGAP = num('--chart-bar-gap', 0.3), DONUT = num('--chart-donut-inner', 0.58); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); const mk = (t, a, tx) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); if (tx != null) e.textContent = tx; return e; }; while (svg.firstChild) svg.removeChild(svg.firstChild); if (!rows.length) return; const kind = enc.kind || 'bar', radial = kind === 'pie' || kind === 'donut'; const cf = enc.color || (radial ? enc.x : ''), six = {}; let sn = 0; const scls = (b, r) => { if (!cf) return b; const k = String(r[cf]); return b + ' mu-chart-s' + ((k in six) ? six[k] : (six[k] = sn++)); }; const doLegend = () => { if (!legend) return; while (legend.firstChild) legend.removeChild(legend.firstChild); if (cf) for (const k in six) { const li = document.createElement('li'); li.className = 'mu-chart-legend-item'; const sw = document.createElement('span'); sw.className = 'mu-chart-swatch mu-chart-s' + six[k]; const tx = document.createElement('span'); tx.className = 'mu-chart-legend-label'; tx.textContent = k; li.appendChild(sw); li.appendChild(tx); legend.appendChild(li); } }; if (radial) { const arc = (X, Y, R, a0, a1, RI) => { const rad = (d) => (d - 90) * Math.PI / 180, s = rad(a0), e = rad(a1), lg = (a1 - a0) > 180 ? 1 : 0; const x0 = X + R * Math.cos(s), y0 = Y + R * Math.sin(s), x1 = X + R * Math.cos(e), y1 = Y + R * Math.sin(e); if (RI <= 0) return 'M' + X + ',' + Y + ' L' + x0 + ',' + y0 + ' A' + R + ',' + R + ' 0 ' + lg + ' 1 ' + x1 + ',' + y1 + ' Z'; const xi0 = X + RI * Math.cos(e), yi0 = Y + RI * Math.sin(e), xi1 = X + RI * Math.cos(s), yi1 = Y + RI * Math.sin(s); return 'M' + x0 + ',' + y0 + ' A' + R + ',' + R + ' 0 ' + lg + ' 1 ' + x1 + ',' + y1 + ' L' + xi0 + ',' + yi0 + ' A' + RI + ',' + RI + ' 0 ' + lg + ' 0 ' + xi1 + ',' + yi1 + ' Z'; }; const total = rows.reduce((a, r) => a + (Number(r[enc.y]) || 0), 0) || 1; const RAD = Math.min(iw, ih) / 2 - 2, RI = kind === 'donut' ? RAD * DONUT : 0, ccx = pL + iw / 2, ccy = pT + ih / 2; let a = 0; for (const r of rows) { const v = Number(r[enc.y]) || 0, a1 = a + v / total * 360; svg.appendChild(mk('path', { d: arc(ccx, ccy, RAD, a, a1, RI), class: scls('mu-chart-slice', r) })); a = a1; } doLegend(); return; } let mx = Math.max(0, ...rows.map((r) => Number(r[enc.y]) || 0)); if (mx <= 0) mx = 1; else { const p = Math.pow(10, Math.floor(Math.log10(mx))); mx = Math.ceil(mx / p) * p; } const sy = (v) => pT + ih - (v / mx) * ih; for (let t = 0; t <= TICKS; t++) { const v = mx * t / TICKS, y = sy(v); svg.appendChild(mk('line', { x1: pL, y1: y, x2: W - pR, y2: y, class: 'mu-chart-grid' })); svg.appendChild(mk('text', { x: pL - 6, y: y + 3, class: 'mu-chart-tick', 'text-anchor': 'end' }, String(Math.round(v)))); } const n = rows.length, bw = iw / n; if (kind === 'scatter') { const xs = rows.map((r) => Number(r[enc.x]) || 0), xmax = Math.max(1, ...xs), xmin = Math.min(0, ...xs), xr = (xmax - xmin) || 1; rows.forEach((r) => svg.appendChild(mk('circle', { cx: pL + ((Number(r[enc.x]) || 0) - xmin) / xr * iw, cy: sy(Number(r[enc.y]) || 0), r: 4, class: scls('mu-chart-dot', r) }))); } else if (kind === 'line' || kind === 'area' || kind === 'point') { const pts = rows.map((r, i) => (pL + bw * (i + 0.5)) + ',' + sy(Number(r[enc.y]) || 0)).join(' '); if (kind === 'area') svg.appendChild(mk('polygon', { points: (pL + bw * 0.5) + ',' + (pT + ih) + ' ' + pts + ' ' + (pL + bw * (n - 0.5)) + ',' + (pT + ih), class: 'mu-chart-area' })); if (kind !== 'point') svg.appendChild(mk('polyline', { points: pts, class: 'mu-chart-line' })); rows.forEach((r, i) => svg.appendChild(mk('circle', { cx: pL + bw * (i + 0.5), cy: sy(Number(r[enc.y]) || 0), r: 3, class: scls('mu-chart-dot', r) }))); } else { rows.forEach((r, i) => { const y = sy(Number(r[enc.y]) || 0); svg.appendChild(mk('rect', { x: pL + bw * i + bw * BARGAP / 2, y: y, width: bw * (1 - BARGAP), height: (pT + ih) - y, class: scls('mu-chart-bar', r) })); }); } if (kind !== 'scatter') rows.forEach((r, i) => svg.appendChild(mk('text', { x: pL + bw * (i + 0.5), y: H - pB + 15, class: 'mu-chart-xlabel', 'text-anchor': 'middle' }, String(r[enc.x] == null ? '' : r[enc.x])))); doLegend(); }
  function __arc(cx, cy, r, a0, a1, ri) { cx = Number(cx); cy = Number(cy); r = Number(r); ri = Number(ri) || 0; const rad = (deg) => (Number(deg) - 90) * Math.PI / 180; const s = rad(a0), e = rad(a1); const large = Math.abs(Number(a1) - Number(a0)) > 180 ? 1 : 0; const x0 = cx + r * Math.cos(s), y0 = cy + r * Math.sin(s), x1 = cx + r * Math.cos(e), y1 = cy + r * Math.sin(e); if (ri <= 0) return 'M' + cx + ',' + cy + ' L' + x0 + ',' + y0 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 + ' Z'; const xi0 = cx + ri * Math.cos(e), yi0 = cy + ri * Math.sin(e), xi1 = cx + ri * Math.cos(s), yi1 = cy + ri * Math.sin(s); return 'M' + x0 + ',' + y0 + ' A' + r + ',' + r + ' 0 ' + large + ' 1 ' + x1 + ',' + y1 + ' L' + xi0 + ',' + yi0 + ' A' + ri + ',' + ri + ' 0 ' + large + ' 0 ' + xi1 + ',' + yi1 + ' Z'; }
  let __dndActive = null; const __dndZones = new Map();
  function __dndMove(e) { const d = __dndActive; if (!d) return; d.overlay.style.transform = 'translate(' + (e.clientX - d.dx) + 'px, ' + (e.clientY - d.dy) + 'px)'; d.overlay.style.visibility = 'hidden'; const stack = document.elementsFromPoint(e.clientX, e.clientY); d.overlay.style.visibility = 'visible'; let zone = null; for (const el of stack) { if (__dndZones.has(el)) { zone = el; break; } } if (zone !== d.over) { if (d.over) d.over.classList.remove('mu-dnd-over'); if (zone) zone.classList.add('mu-dnd-over'); d.over = zone; } }
  function __dndEnd() { window.removeEventListener('pointermove', __dndMove); window.removeEventListener('pointerup', __dndEnd); const d = __dndActive; __dndActive = null; if (!d) return; d.overlay.remove(); d.src.classList.remove('mu-dnd-ghost'); if (d.over) { d.over.classList.remove('mu-dnd-over'); const z = __dndZones.get(d.over); if (z) z.onDrop(d.id); } }
  function __drag(el, getId) { el.style.touchAction = 'none'; el.classList.add('mu-dnd-item'); el.addEventListener('pointerdown', (e) => { if (e.button !== 0 || __dndActive) return; const cs = getComputedStyle(el); const threshold = parseFloat(cs.getPropertyValue('--mu-dnd-activation')) || 0; const z = cs.getPropertyValue('--mu-dnd-z').trim() || '99999'; const sx = e.clientX, sy = e.clientY; const begin = (ev) => { const overlay = el.cloneNode(true); const r = el.getBoundingClientRect(); overlay.classList.add('mu-dnd-overlay'); overlay.style.cssText += ';position:fixed;left:0;top:0;width:' + r.width + 'px;height:' + r.height + 'px;margin:0;pointer-events:none;z-index:' + z + ';'; document.body.appendChild(overlay); el.classList.add('mu-dnd-ghost'); __dndActive = { id: getId(), overlay: overlay, src: el, dx: sx - r.left, dy: sy - r.top, over: null }; __dndMove(ev); window.addEventListener('pointermove', __dndMove); window.addEventListener('pointerup', __dndEnd); }; if (threshold <= 0) { e.preventDefault(); begin(e); return; } const pre = (ev) => { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < threshold) return; window.removeEventListener('pointermove', pre); window.removeEventListener('pointerup', cancel); ev.preventDefault(); begin(ev); }; const cancel = () => { window.removeEventListener('pointermove', pre); window.removeEventListener('pointerup', cancel); }; window.addEventListener('pointermove', pre); window.addEventListener('pointerup', cancel); }); }
  function __drop(el, group, onDrop) { __dndZones.set(el, { group: group, onDrop: onDrop }); }`;

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
  function map(v, a, b, c, d) { const lo = Number(a), hi = Number(b); return hi === lo ? Number(c) : Number(c) + (Number(v) - lo) * (Number(d) - Number(c)) / (hi - lo); }
  function sin(x) { return Math.sin(Number(x)); }
  function cos(x) { return Math.cos(Number(x)); }
  function sqrt(x) { const n = Number(x); return n < 0 ? 0 : Math.sqrt(n); }
  function abs(x) { return Math.abs(Number(x)); }
  function round(x) { return Math.round(Number(x)); }
  function floor(x) { return Math.floor(Number(x)); }
  function ceil(x) { return Math.ceil(Number(x)); }
  function pow(x, y) { return Math.pow(Number(x), Number(y)); }
  function min(a, b) { return Math.min(Number(a), Number(b)); }
  function max(a, b) { return Math.max(Number(a), Number(b)); }
  function pi() { return Math.PI; }
  function ago(iso) { const t = new Date(iso).getTime(); if (isNaN(t)) return String(iso == null ? '' : iso); const s = (Date.now() - t) / 1000; if (s < 45) return 'just now'; if (s < 5400) return Math.max(1, Math.round(s / 60)) + 'm ago'; if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago'; }
  function date(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  function time(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function now() { return new Date().toISOString(); }
  function before(s, sep) { s = String(s == null ? '' : s); const i = s.indexOf(String(sep == null ? '' : sep)); return i < 0 ? s : s.slice(0, i); }
  function after(s, sep) { const str = String(s == null ? '' : s), sp = String(sep == null ? '' : sep); const i = str.indexOf(sp); return i < 0 ? '' : str.slice(i + sp.length); }
  function datetime(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function weekday(iso) { const d = new Date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleDateString(undefined, { weekday: 'long' }); }
  function calendar(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso == null ? '' : iso); const n = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((day(n) - day(d)) / 86400000); const tm = time(iso); if (diff === 0) return 'Today at ' + tm; if (diff === 1) return 'Yesterday at ' + tm; if (diff === -1) return 'Tomorrow at ' + tm; return date(iso) + ' at ' + tm; }
  function isToday(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return false; const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); }
  function isPast(iso) { const t = new Date(iso).getTime(); return !isNaN(t) && t < Date.now(); }
  function isFuture(iso) { const t = new Date(iso).getTime(); return !isNaN(t) && t > Date.now(); }
  function isEmail(s) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(s == null ? '' : s).trim()); }
  function daysUntil(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return 0; const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); return Math.round((day(d) - day(new Date())) / 86400000); }
  function dayKey(iso) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso == null ? '' : iso); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function addDays(iso, n) { const d = new Date(iso); if (isNaN(d.getTime())) return String(iso == null ? '' : iso); d.setDate(d.getDate() + (Number(n) || 0)); return d.toISOString(); }`;

function sourceLayer(parts: EmitParts): string {
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
  function __refetch(name, params, sig) { const q = __req(__SOURCES[name], __API); let url = q.url; const rest = {}; for (const k in params) { const tok = '{' + k + '}'; if (url.indexOf(tok) >= 0) url = url.split(tok).join(encodeURIComponent(params[k])); else rest[k] = params[k]; } const qs = Object.keys(rest).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(rest[k])).join('&'); url = qs ? url + (url.indexOf('?') >= 0 ? '&' : '?') + qs : url; sig.set({ ...sig.get(), loading: true, error: null }); fetch(url, { method: q.method, headers: { ...q.headers } }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((j) => sig.set({ data: __fill(name, __rows(j, q.at)), loading: false, error: null })).catch((e) => sig.set({ ...sig.get(), loading: false, error: String(e) })); }
  function __send(url, method, body) { let d = { url: url, method: method }; const ci = url.indexOf(':'); if (ci > 0 && __API[url.slice(0, ci)]) d = { api: url.slice(0, ci), url: url.slice(ci + 1), method: method }; const q = __req(d, __API); const init = { method: q.method, headers: { ...q.headers } }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(q.url, init).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.status === 204 ? null : r.json().catch(() => null); }); }
  function query(name, live) { const sig = signal({ data: [], loading: true, error: null }); if (live) { let ws, tries = 0, dead = false; const open = () => { if (dead) return; const q = __req(__SOURCES[name], __API); ws = new WebSocket(q.url); ws.onopen = () => { tries = 0; }; ws.onmessage = (e) => { try { sig.set({ data: __fill(name, __rows(JSON.parse(e.data), q.at)), loading: false, error: null }); } catch {} }; ws.onerror = () => { sig.set({ ...sig.get(), error: 'socket error' }); }; ws.onclose = () => { if (dead) return; sig.set({ ...sig.get(), loading: false }); setTimeout(open, Math.min(1000 * 2 ** tries++, 15000)); }; }; open(); onCleanup(() => { dead = true; if (ws) ws.close(); }); } else { __fetch(name).then((d) => sig.set({ data: d, loading: false, error: null })).catch((e) => sig.set({ data: [], loading: false, error: String(e) })); } return sig; }`;
}

// ── usage-based emission ─────────────────────────────────────────────────────────────────────────────────
// A page/store emits ONLY the runtime it actually uses: the builtins it calls, the source/persist layer if it
// reads/writes/persists, and an import naming just the runtime symbols it references. A counter (signal + effect)
// gets none of the rest. On the vite path the bundler would prune it anyway; the standalone-HTML / SSG path has
// no bundler, so this is what keeps a built static page from carrying the whole data layer it never touches.

// builtin name -> source, derived from BUILTINS_JS (one `function NAME(...) {…}` per line); plus the only
// inter-builtin dependency (calendar calls time + date), so a page emits the closure of what it calls.
const BUILTIN_SRC: { readonly [name: string]: string } = Object.fromEntries(
  BUILTINS_JS.split('\n').map((l) => l.trim()).filter(Boolean).map((src) => [src.slice(9, src.indexOf('(')), src]),
);
const BUILTIN_DEPS: { readonly [name: string]: readonly string[] } = { calendar: ['time', 'date'] };

function usedBuiltins(body: string): string {
  const want = new Set<string>();
  const add = (n: string): void => { if (want.has(n) || !BUILTIN_SRC[n]) return; want.add(n); (BUILTIN_DEPS[n] || []).forEach(add); };
  for (const n in BUILTIN_SRC) if (new RegExp(`\\b${n}\\(`).test(body)) add(n);
  return Object.keys(BUILTIN_SRC).filter((n) => want.has(n)).map((n) => BUILTIN_SRC[n]).join('\n  ');
}

// localStorage helpers — emitted only for a page with `persist` state.
const PERSIST_JS = `const __loadLocal = (k, fb) => { try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); } catch (e) { return fb; } };
  const __saveLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };`;

// the runtime prelude a body needs: builtins called + persist (if it persists) + the source layer (if it
// reads/writes/sends). Detection scans the COMPILED body for the helper-call patterns the emitter produces.
function prelude(parts: EmitParts, body: string): string {
  const out: string[] = [];
  const b = usedBuiltins(body);
  if (b) out.push(b);
  if (/\b__loadLocal\(|\b__saveLocal\(/.test(body)) out.push(PERSIST_JS);
  if (/\bquery\(|\b__fetch\(|\b__write\(|\b__refetch\(|\b__send\(/.test(body)) out.push(sourceLayer(parts));
  return out.join('\n  ');
}

// only the runtime symbols the emitted code references — `signal, effect` for a counter, not all nine. A stray
// match merely imports an unused symbol (the bundler drops it); a miss can't happen (the emitter always writes
// these as `name(` calls / `__sym` references that `\bname\b` catches).
const RUNTIME_SYMBOLS = ['signal', 'computed', 'effect', 'root', 'onCleanup', '__eq', '__id', '__has', '__order', '__chart', '__arc', '__drag', '__drop'] as const;
function runtimeImport(code: string): string {
  const used = RUNTIME_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(code));
  return used.length ? `import { ${used.join(', ')} } from 'virtual:muten/runtime';\n` : '';
}

// One .store domain slice -> shared ESM module (state + get + actions, no DOM).
export function emitStore(parts: EmitParts): string {
  const body = [parts.stateDecls, parts.getDecls, parts.actionDecls, parts.effectDecls].join('\n');
  const pre = prelude(parts, body);
  return `${runtimeImport(pre + body)}${parts.externImports}

  ${pre}

${parts.stateDecls}

${parts.getDecls}

${parts.actionDecls}

${parts.effectDecls}
${parts.dev && parts.storeDomain ? `\nif (typeof window !== 'undefined') (window.__muten_stores = window.__muten_stores || {})[${JSON.stringify(parts.storeDomain)}] = { ${parts.ctxNames.join(', ')} };  // dev: expose this store slice for the DevTools` : ''}
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
  const body = [parts.storeDecls, parts.paramDecls, parts.stateDecls, parts.getDecls, parts.actionDecls, parts.componentDecls, parts.renderBody].join('\n');
  const needsData = /\bquery\(/.test(body);
  const needsId = needsData || /\b__id\(/.test(body);
  return `${RUNTIME}
  ${usedBuiltins(body)}
  ${needsId ? `let __seq = 0;
  function __id() { return 'id-' + (++__seq); }` : ''}
  ${needsData ? `const __DATA = ${JSON.stringify(parts.data)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
  function query(name) { return signal({ data: __fill(name, __DATA[name] ?? []), loading: false, error: null }); }` : ''}

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
  const body = [parts.paramDecls, parts.stateDecls, parts.getDecls, parts.actionDecls, parts.componentDecls, parts.renderBody, parts.effectDecls].join('\n');
  const pre = prelude(parts, body);
  return `${runtimeImport(pre + body)}${parts.storeImports}
${parts.externImports}
export const screen = ${JSON.stringify(parts.screen)};
export const css = ${JSON.stringify(parts.projectCss)};
export const meta = ${JSON.stringify(parts.meta)};

export function mount(app, __params) {
  ${pre}

  ${parts.paramDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  ${parts.renderBody}

  ${parts.effectDecls}
  ${parts.dev
    ? `const __el = ${parts.hasSlot ? '__outlet' : 'app'};\n  __el.__muten = { el: __el, ctx: { ${parts.ctxNames.join(', ')} }, nodes: __nodes };  // live HMR handle: ctx + node registry\n  return __el;`
    : `return ${parts.hasSlot ? '__outlet' : 'app'};`}
}
`;
}

// HMR patch builder: ONE node's subtree as a function, rebuilt against the LIVE `ctx` (state/actions/gets/params
// as addressable data) + the live node registry. The dev server compiles + sends this on a local edit; the
// client evals it and hands it to patchNode by id, so only that node re-renders while all state survives.
export function emitPatch(parts: EmitParts, rootId: string): string {
  return `(ctx, nodes, parent, __rt) => {
  const { signal, computed, effect, root, onCleanup, __eq, __order, __has, __id } = __rt;
  const __nodes = nodes;
  ${parts.renderBody}
  return el_${rootId};
}`;
}

// Self-contained HTML document: runtime inlined, browser runs it directly.
export function emitHtml(parts: EmitParts): string {
  const body = [parts.storeDecls, parts.stateDecls, parts.getDecls, parts.actionDecls, parts.componentDecls, parts.renderBody].join('\n');
  const pre = prelude(parts, body);
  const idDecl = /\b__id\(/.test(pre + body) ? `let __seq = 0;
  function __id() { return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + (++__seq); }` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  ${parts.projectCss}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
  ${RUNTIME}

  ${idDecl}

  ${pre}

  ${parts.storeDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  const app = document.getElementById('app');
  app.replaceChildren();
  ${parts.renderBody}
</script>
</body>
</html>
`;
}
