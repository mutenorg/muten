// emit.ts: assembles pre-computed EmitParts into the final output for each format.
// Formats: self-contained HTML, ESM page module, ESM store slice, static page.
// The data layer (dataLayer) is written once and shared by every runtime format.
// Consumed by compile.ts as the last step of the compile pipeline.

import type { EmitParts } from '#engine/shared/types.js';
import { BUILTIN_PREFIX } from '#engine/shared/vocab.js';
import { CALL_QUERY_JS, EVERY_JS, SCRIPT_JS, ROWS_JS, CHANGE_JS, FEED_JS } from '#engine/compile/runtime-snippets.js';
import { readFileSync } from 'node:fs';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

// The signals runtime for the outputs with no bundler (the standalone HTML page, the build-time pre-render): the SAME
// runtime.ts every bundled page runs, built as one script (dist/runtime-inline.js, see esbuild.ts). Read on first use,
// so the engine's lint-only consumers never touch the file.
let inlineRuntime = '';
function runtimeScript(own: readonly string[] = []): string {
  if (!inlineRuntime) inlineRuntime = readFileSync(new URL('../../runtime-inline.js', import.meta.url), 'utf8');
  return `${inlineRuntime}\nconst { ${RUNTIME_SYMBOLS.filter((name) => !own.includes(name)).join(', ')} } = __mutenRt;`;
}

// The data layer: a query is a reactive signal { data, loading, error }. Real `sources` fetch over
// HTTP; otherwise a mock with a small delay so loading/error states are visible. `__req`/`__rows`
// are inlined from engine/shared/source.ts so build-time SSG and runtime fetching are identical.
// Built-in pure functions: a FIXED, oracle-known vocabulary for the universal formatting needs (dates, case,
// initials, currency, truncation) so they never force a `use` escape. Inlined in every JS path (and SSR), so a
// model writes `{ago(msg.time)}` / `{initial(user.name)}` instead of hand-rolling buggy Date/string logic.
export const BUILTINS_JS = `function __safeUrl(u, media) { u = String(u == null ? '' : u); const bare = u.replace(/[\\u0000-\\u0020\\u007f-\\u009f]/g, '').toLowerCase(); const scheme = /^([a-z][a-z0-9+.-]*):/.exec(bare); if (!scheme) return u; const name = scheme[1]; if (name === 'javascript' || name === 'vbscript' || name === 'livescript') return 'about:blank#blocked'; if (name === 'data') return media && /^data:(image|video|audio)\\//.test(bare) && bare.indexOf('svg') < 0 ? u : 'about:blank#blocked'; return u; }
  function __seg(v) { const s = String(v == null ? '' : v); return s === '.' || s === '..' ? s.replace(/\\./g, '%2E') : encodeURIComponent(s); }
  function upper(s) { return String(s == null ? '' : s).toUpperCase(); }
  function lower(s) { return String(s == null ? '' : s).toLowerCase(); }
  function initial(s) { return String(s == null ? '' : s).trim().charAt(0).toUpperCase(); }
  function initials(s) { const words = String(s == null ? '' : s).trim().split(/\\s+/).filter(Boolean); return ((words[0] || '').charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '')).toUpperCase(); }
  function hue(s) { let h = 0; for (const c of String(s == null ? '' : s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function truncate(s, n) { s = String(s == null ? '' : s); n = Number(n) || 0; return s.length > n ? s.slice(0, n) + '…' : s; }
  function money(n, cur, loc) { const v = Number(n) || 0; try { return new Intl.NumberFormat(loc || undefined, cur === '' ? { maximumFractionDigits: 2 } : { style: 'currency', currency: cur || 'USD', ...(Number.isInteger(v) ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) }).format(v); } catch (e) { return String(v); } }
  function fixed(n, d, loc) { const k = Math.max(0, Math.min(20, Number(d) || 0)); try { return new Intl.NumberFormat(loc || undefined, { minimumFractionDigits: k, maximumFractionDigits: k }).format(Number(n) || 0); } catch (e) { return (Number(n) || 0).toFixed(k); } }
  function percent(n, d, loc) { const k = Math.max(0, Math.min(20, Number(d) || 0)); return new Intl.NumberFormat(loc || undefined, { style: 'percent', maximumFractionDigits: k }).format(Number(n) || 0); }
  function pad(n, w) { return String(n == null ? '' : n).padStart(Number(w) || 0, '0'); }
  function num(s) { const v = Number(String(s == null ? '' : s).trim().replace(',', '.')); return isNaN(v) ? 0 : v; }
  function trim(s) { return String(s == null ? '' : s).trim(); }
  function digits(s) { return String(s == null ? '' : s).replace(/\\D+/g, ''); }
  function slugify(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function replace(s, find, by) { return String(s == null ? '' : s).split(String(find == null ? '' : find)).join(String(by == null ? '' : by)); }
  function startsWith(s, p) { return String(s == null ? '' : s).startsWith(String(p == null ? '' : p)); }
  function endsWith(s, p) { return String(s == null ? '' : s).endsWith(String(p == null ? '' : p)); }
  function split(s, sep) { return String(s == null ? '' : s).split(sep == null ? ',' : String(sep)).map((x) => x.trim()).filter(Boolean); }
  function joined(list, sep) { return (Array.isArray(list) ? list : []).map((x) => String(x == null ? '' : x)).join(sep == null ? ', ' : String(sep)); }
  function urlParam(name) { try { return new URLSearchParams(globalThis.location ? location.search : '').get(String(name)) ?? ''; } catch (e) { return ''; } }
  function copy(s) { const text = String(s == null ? '' : s); try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => {}); return true; } } catch (e) {} try { const box = document.createElement('textarea'); box.value = text; box.setAttribute('readonly', ''); box.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'; document.body.appendChild(box); box.select(); const ok = document.execCommand('copy'); box.remove(); return ok; } catch (e) { return false; } }
  function share(text, url) { const t = String(text == null ? '' : text); const data = url ? { text: t, url: String(url) } : /^https?:\\/\\//.test(t) ? { url: t } : { text: t }; try { if (navigator.share) return navigator.share(data).then(() => true, () => false); } catch (e) {} return Promise.resolve(copy(url || t)); }
  function play(src) { try { const a = new Audio(__safeUrl(src, true)); a.play().catch(() => {}); return true; } catch (e) { return false; } }
  function scrollTo(target) { const el = typeof target === 'string' && typeof document !== 'undefined' ? document.querySelector(target) : null; if (!el) return false; el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); return true; }
  function preview(file) { if (typeof file === 'string') return file; if (!file || typeof Blob === 'undefined' || !(file instanceof Blob)) return ''; const seen = globalThis.__muPreviews || (globalThis.__muPreviews = new WeakMap()); if (!seen.has(file)) seen.set(file, URL.createObjectURL(file)); return seen.get(file); }
  function resize(file, side) { if (!file || typeof createImageBitmap === 'undefined' || !(file instanceof Blob) || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return Promise.resolve(file); return createImageBitmap(file).then((img) => { const k = Math.min(1, Number(side) / Math.max(img.width, img.height)); if (k >= 1) return file; const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); const base = String(file.name || 'image').lastIndexOf('.') > 0 ? String(file.name).slice(0, String(file.name).lastIndexOf('.')) : String(file.name || 'image'); const fallback = file.type === 'image/png' ? 'image/png' : 'image/jpeg'; const made = (b) => (b ? new File([b], base + ({ 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg' }[b.type] || ''), { type: b.type }) : file); return new Promise((done) => c.toBlob((b) => (b && b.type === 'image/webp' ? done(made(b)) : c.toBlob((x) => done(made(x)), fallback, 0.86)), 'image/webp', 0.86)); }).catch(() => file); }
  function element(selector) { return typeof document !== 'undefined' ? document.querySelector(String(selector)) : null; }
  function visit(url) { const u = __safeUrl(url); if (!u || u.indexOf('about:blank') === 0 || typeof document === 'undefined') return false; const a = document.createElement('a'); a.href = u; a.hidden = true; document.body.appendChild(a); a.click(); a.remove(); return true; }
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
  function __dateOnly(iso) { return /^\\d{4}-\\d{2}-\\d{2}$/.test(String(iso == null ? '' : iso)); }
  function __date(iso) { return new Date(__dateOnly(iso) ? iso + 'T00:00:00' : iso); }
  function __ymd(d) { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function ago(iso, loc) { const t = __date(iso).getTime(); if (isNaN(t)) return String(iso == null ? '' : iso); const s = (t - Date.now()) / 1000, a = Math.abs(s); const rtf = new Intl.RelativeTimeFormat(loc || undefined, { numeric: 'auto' }); if (a < 45) return rtf.format(0, 'second'); if (a < 5400) return rtf.format(Math.round(s / 60) || Math.sign(s), 'minute'); if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour'); if (a < 2592000) return rtf.format(Math.round(s / 86400), 'day'); if (a < 31536000) return rtf.format(Math.round(s / 2592000), 'month'); return rtf.format(Math.round(s / 31536000), 'year'); }
  function date(iso, loc) { const d = __date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleDateString(loc || undefined, { month: 'short', day: 'numeric' }); }
  function time(iso, loc) { const d = __date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleTimeString(loc || undefined, { hour: 'numeric', minute: '2-digit' }); }
  function now() { return new Date().toISOString(); }
  function before(s, sep) { s = String(s == null ? '' : s); const i = s.indexOf(String(sep == null ? '' : sep)); return i < 0 ? s : s.slice(0, i); }
  function after(s, sep) { const str = String(s == null ? '' : s), sp = String(sep == null ? '' : sep); const i = str.indexOf(sp); return i < 0 ? '' : str.slice(i + sp.length); }
  function datetime(iso, loc) { const d = __date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleString(loc || undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function weekday(iso, loc) { const d = __date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : d.toLocaleDateString(loc || undefined, { weekday: 'long' }); }
  function calendar(iso, loc) { const d = __date(iso); if (isNaN(d.getTime())) return String(iso == null ? '' : iso); const n = new Date(); const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); const diff = Math.round((day(d) - day(n)) / 86400000); const tm = time(iso, loc); if (Math.abs(diff) > 1) return date(iso, loc) + ', ' + tm; const word = new Intl.RelativeTimeFormat(loc || undefined, { numeric: 'auto' }).format(diff, 'day'); return word.charAt(0).toLocaleUpperCase() + word.slice(1) + ', ' + tm; }
  function isToday(iso) { const d = __date(iso); if (isNaN(d.getTime())) return false; const n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate(); }
  function isPast(iso) { const t = __date(iso).getTime(); return !isNaN(t) && t < Date.now(); }
  function isFuture(iso) { const t = __date(iso).getTime(); return !isNaN(t) && t > Date.now(); }
  function isEmail(s) { return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(s == null ? '' : s).trim()); }
  function daysUntil(iso) { const d = __date(iso); if (isNaN(d.getTime())) return 0; const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); return Math.round((day(d) - day(new Date())) / 86400000); }
  function dayKey(iso) { const d = __date(iso); return isNaN(d.getTime()) ? String(iso == null ? '' : iso) : __ymd(d); }
  function addDays(iso, n) { const d = __date(iso); if (isNaN(d.getTime())) return String(iso == null ? '' : iso); d.setDate(d.getDate() + (Number(n) || 0)); return __dateOnly(iso) ? __ymd(d) : d.toISOString(); }`;

function sourceLayer(parts: EmitParts): string {
  return `const __DATA = ${JSON.stringify(parts.data)};
  const __SOURCES = ${JSON.stringify(parts.sources)};
  const __API = ${JSON.stringify(parts.api)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __DELAY = 450;
  const __req = ${sourceRequest.toString()};
  // THE AUTH SEAM. \`api { headers }\` is a literal block serialized at build time, so it can carry an
  // environment key but never a PER-USER token — the one thing every authenticated app needs. Making
  // the block itself reactive would mean threading the expression compiler through the emitter, so
  // instead the fetch layer asks, on every request, for headers that may have changed since the last
  // one. A \`use\` lib installs the provider (\`globalThis.__mutenHeaders = () => ({ authorization: … })\`)
  // and muten keeps the token in normal state. Absent a provider this is an empty object and nothing
  // about the old behaviour changes.
  // THE USER'S SESSION ONLY GOES HOME. The per-user headers (a bearer token) ride a request only to this page's own origin
  // or to a backend the app declared in \`api { base }\`: never to a third-party source, and never to a URL that data built.
  const __OWN = (() => { const out = []; const add = (b) => { if (typeof b === 'string' && b) { try { out.push(new URL(b, typeof location !== 'undefined' ? location.href : 'http://localhost/').origin); } catch (e) {} } }; add(__API && __API.base); if (__API && typeof __API === 'object') for (const k of Object.keys(__API)) { const c = __API[k]; if (c && typeof c === 'object') add(c.base); } return out; })();
  const __own = (u) => { try { if (typeof location === 'undefined') return true; const o = new URL(u, location.href).origin; return o === location.origin || __OWN.indexOf(o) >= 0; } catch (e) { return false; } };
  const __hdrs = (u) => { if (u !== undefined && !__own(u)) return {}; try { const f = globalThis.__mutenHeaders; return typeof f === 'function' ? (f() || {}) : {}; } catch (e) { return {}; } };
  const __rows = ${sourceRows.toString()};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { if (r === null || typeof r !== 'object') return r; const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
  // THE SAME LIST ASKED TWICE AT ONCE IS ONE REQUEST. Two stores, or a store and a page, loading the same source in the
  // same moment sent it twice (/channels/open, /pub/week). A GET already in flight with the same address and headers
  // is shared; once it settles the next load asks again. Each reader gets its own copy of the response.
  const __flight = globalThis.__mutenFlight || (globalThis.__mutenFlight = {}); // one per app: every page and store module shares it
  // THE LAST LIST SEEN IS SHOWN AT ONCE. Coming back to a page started its lists from nothing (blank or a skeleton)
  // while the same request went out again. Each GET address keeps the last rows it showed (your own optimistic writes
  // included, so a deleted row never flashes back), keyed with the session headers so one user never sees another's;
  // a query shows them at once and asks the server again quietly (stale-while-revalidate). Fifty addresses at most.
  const __cache = globalThis.__mutenCache || (globalThis.__mutenCache = new Map());
  function __cacheKey(url) { return JSON.stringify([url, __hdrs(url)]); }
  function __remember(sig) { const set = sig.set; sig.set = (v) => { set(v); if (sig.__key && v && !v.loading && !v.error) { __cache.delete(sig.__key); __cache.set(sig.__key, v.data); if (__cache.size > 50) __cache.delete(__cache.keys().next().value); } }; }
  function __shared(url, init) { if ((init.method || 'GET') !== 'GET') return fetch(url, init); const key = JSON.stringify([url, init.headers || {}]); if (!__flight[key]) __flight[key] = fetch(url, init).finally(() => { delete __flight[key]; }); return __flight[key].then((r) => r.clone()); }
  function __fetch(name) { const s = __SOURCES[name]; if (s) { const q = __req(s, __API); const init = { method: q.method, headers: { ...q.headers, ...__hdrs(q.url) }, credentials: q.credentials || undefined }; if (q.body != null) { init.body = q.body; if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return __shared(q.url, init).then((r) => { if (!r.ok) return r.json().catch(() => null).then((j) => { const why = j && typeof j.error === 'string' ? ' ' + j.error.slice(0, 80) : ''; throw new Error('HTTP ' + r.status + why); }); return r.json(); }).then((j) => __fill(name, __rows(j, q.at))); } return new Promise((res) => setTimeout(() => res(__fill(name, __DATA[name] ?? [])), __DELAY)); }
  function __write(name, method, id, body) { const s = __SOURCES[name]; if (!s) return Promise.resolve(method === 'DELETE' ? null : { ...body, id: body && body.id != null ? body.id : __id() }); /* a list with only its mock (muten test): the write echoes */ const q = __req(s, __API); let url = q.url; if (id != null) { url = (url.charAt(url.length - 1) === '/' ? url.slice(0, -1) : url) + '/' + encodeURIComponent(id); } const init = { method: method, headers: { ...q.headers, ...__hdrs(url) }, credentials: q.credentials || undefined }; if (body != null) { init.body = JSON.stringify(body); if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = 'application/json'; } return fetch(url, init).then((r) => { if (!r.ok) return r.json().catch(() => null).then((j) => { const why = j && typeof j.error === 'string' ? ' ' + j.error.slice(0, 80) : ''; throw new Error('HTTP ' + r.status + why); }); return method === 'DELETE' ? null : r.json(); }); }
  // Optimistic list writes. Every row keeps a slot: writes to it run one after another (a PUT never
  // races the POST that created the row, and goes to the server's id once that POST answers), and only
  // the LATEST write's answer or failure may touch the row. Without this a slower, older answer lands
  // on top of a newer tap: a switch flipped three times jumps back when the first reply arrives. An
  // update MERGES onto the row it shows: update({ id, active }) must not drop the row's other fields
  // (a getter filtering by kind lost the row until the server answered). Queued PUTs coalesce: a PUT still
  // waiting when a newer PUT arrives is folded into it, so ten quick taps cost two requests, not ten.
  const __book = {};
  function __crud(name, method, item, get, set) { const isNew = method === 'POST'; const i = isNew ? { ...item } : item; if (isNew && i.id == null) i.id = __id(); const book = __book[name] || (__book[name] = {}); const key = i.id; const slot = book[key] || (book[key] = { seq: 0, chain: Promise.resolve(), real: isNew ? null : key, dead: false, carry: null, next: method }); const mine = ++slot.seq; slot.next = method; const hit = (x) => x != null && (x.id === key || (slot.real != null && x.id === slot.real)); const list = get(); const at = list.findIndex(hit); const before = at >= 0 ? list[at] : null; set(isNew ? [...list, i] : method === 'PUT' ? list.map((x) => hit(x) ? { ...x, ...i } : x) : list.filter((x) => !hit(x))); const run = slot.chain.then(() => { if (slot.dead) throw new Error('create failed'); const bare = method === 'DELETE' ? null : { ...(method === 'PUT' ? slot.carry : null), ...i }; if (bare && slot.real != null) bare.id = slot.real; if (method === 'PUT' && mine !== slot.seq && slot.next === 'PUT') { slot.carry = bare; return null; } slot.carry = null; return __write(name, method, isNew ? null : slot.real, bare); }); slot.chain = run.then(() => {}, () => {}); return run.then((r) => { if (isNew && r && r.id != null) { slot.real = r.id; book[r.id] = slot; } if (method === 'DELETE' || mine !== slot.seq) return; set(get().map((x) => hit(x) ? r : x)); }, (e) => { if (isNew) { slot.dead = true; set(get().filter((x) => !hit(x))); throw e; } if (slot.dead || mine !== slot.seq) throw e; const now = get(); if (method === 'PUT') { if (before) set(now.map((x) => hit(x) ? before : x)); } else if (before && !now.some(hit)) { const next = now.slice(); next.splice(Math.min(at, next.length), 0, before); set(next); } throw e; }); }
  function __refetch(name, params, sig) { if (sig) sig.__params = params; if (sig && typeof sig.__reopen === 'function') { sig.__reopen(params); return; } const q = __req(__SOURCES[name], __API); let url = q.url; const rest = {}; for (const k in params) { const tok = '{' + k + '}'; if (url.indexOf(tok) >= 0) url = url.split(tok).join(encodeURIComponent(params[k])); else rest[k] = params[k]; } const qs = Object.keys(rest).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(rest[k])).join('&'); url = qs ? url + (url.indexOf('?') >= 0 ? '&' : '?') + qs : url; sig.__started = true; const tok = (sig.__tok = (sig.__tok || 0) + 1); if (sig.__ctl) sig.__ctl.abort(); const ctl = (sig.__ctl = typeof AbortController === 'function' ? new AbortController() : null); const __k = q.method === 'GET' ? __cacheKey(url) : ''; sig.__key = __k; const __hit = __k ? __cache.get(__k) : undefined; sig.set({ ...sig.get(), ...(__hit ? { data: __hit } : {}), loading: true, error: null }); fetch(url, { method: q.method, headers: { ...q.headers, ...__hdrs(url) }, credentials: q.credentials || undefined, signal: ctl ? ctl.signal : undefined }).then((r) => { if (!r.ok) return r.json().catch(() => null).then((j) => { const why = j && typeof j.error === 'string' ? ' ' + j.error.slice(0, 80) : ''; throw new Error('HTTP ' + r.status + why); }); return r.json(); }).then((j) => { if (sig.__tok === tok) sig.set({ data: __fill(name, __rows(j, q.at)), loading: false, error: null }); }).catch((e) => { if (sig.__tok === tok) sig.set({ ...sig.get(), loading: false, error: String(e) }); }); }
  function __send(url, method, body) { let d = { url: url, method: method }; const ci = url.indexOf(':'); if (ci > 0 && __API[url.slice(0, ci)]) d = { api: url.slice(0, ci), url: url.slice(ci + 1), method: method }; const q = __req(d, __API); const init = { method: q.method, headers: { ...q.headers, ...__hdrs(q.url) }, credentials: q.credentials || undefined }; return __payload(body).then((p) => { if (p) { init.body = p.body; if (p.form) { delete init.headers['content-type']; delete init.headers['Content-Type']; } else if (!init.headers['content-type'] && !init.headers['Content-Type']) init.headers['content-type'] = p.type; } return fetch(q.url, init); }).then((r) => { if (!r.ok) return r.json().catch(() => null).then((j) => { const why = j && typeof j.error === 'string' ? ' ' + j.error.slice(0, 80) : ''; throw new Error('HTTP ' + r.status + why); }); return r.status === 204 ? null : r.json().catch(() => null); }); }
  // what a «post … body» sends: a file alone goes as it is (a receipt, byte for byte); an object holding a file goes as a
  // form (multipart, the browser sets its boundary); anything else as JSON. Values still being made («resize(photo, 1600)») are waited for.
  function __payload(body) { if (body == null) return Promise.resolve(null); const isFile = (v) => typeof Blob !== 'undefined' && v instanceof Blob; return Promise.resolve(body).then((b) => { if (isFile(b)) return { body: b, type: b.type || 'application/octet-stream' }; if (!b || typeof b !== 'object' || Array.isArray(b)) return { body: JSON.stringify(b), type: 'application/json' }; return Promise.all(Object.entries(b).map(([k, v]) => Promise.resolve(v).then((x) => [k, x]))).then((entries) => { if (!entries.some(([, v]) => isFile(v) || (Array.isArray(v) && v.some(isFile)))) return { body: JSON.stringify(Object.fromEntries(entries)), type: 'application/json' }; const form = new FormData(); for (const [k, v] of entries) { if (v == null) continue; if (isFile(v)) form.append(k, v, v.name || k); else if (Array.isArray(v) && v.some(isFile)) v.forEach((x) => form.append(k, x, x.name || k)); else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v)); } return { body: form, form: true }; }); }); }
  // a live message: a whole list replaces it; { upsert: row | rows } and { remove: id | ids } change only those rows
  function __live(name, rows, m, at) { if (m && !Array.isArray(m) && typeof m === 'object' && ('upsert' in m || 'remove' in m)) { let next = rows || []; const gone = [].concat(m.remove == null ? [] : m.remove); if (gone.length) next = next.filter((r) => !gone.includes(r && r.id)); const ups = __fill(name, [].concat(m.upsert == null ? [] : m.upsert)); for (const u of ups) { const at2 = next.findIndex((r) => r && u && r.id === u.id); next = at2 < 0 ? [...next, u] : next.map((r, i) => (i === at2 ? u : r)); } return next; } return __fill(name, __rows(m, at)); }
  function query(name, live) { const sig = signal({ data: [], loading: true, error: null }); if (live) { let ws, tries = 0, dead = false, params = {}; const outbox = []; sig.__send = (x) => { const text = JSON.stringify(x); if (ws && ws.readyState === 1) ws.send(text); else if (outbox.length < 100) outbox.push(text); }; const open = () => { if (dead) return; const q = __req(__SOURCES[name], __API);
    // A browser WebSocket takes NO headers, so a live query could never carry a per-user token or a
    // scope — which is every authenticated real-time list there is. The scope (\`refetch\`'s params) travels as the
    // query string; the bearer as a subprotocol (below), never in the url. http/https becomes
    // ws/wss, so a source stays a plain path and \`api { base }\` needs no second address.
    // The bearer does NOT go in the url (access logs keep urls): it rides the one header a page can set on a socket, the
    // subprotocol list, as \`muten.bearer.<hex>\` (hex: a subprotocol takes only token characters). The server answers \`muten\`.
    const __h = __hdrs(q.url); const __b = String(__h.authorization || __h.Authorization || '').replace(/^Bearer /, '');
    const __protos = __b ? ['muten', 'muten.bearer.' + Array.from(new TextEncoder().encode(__b), (x) => x.toString(16).padStart(2, '0')).join('')] : undefined;
    const __all = { ...params };
    const __qs = Object.keys(__all).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(__all[k])).join('&');
    let __u = q.url.replace(/^http/, 'ws'); if (__qs) __u += (__u.indexOf('?') >= 0 ? '&' : '?') + __qs;
    ws = __protos ? new WebSocket(__u, __protos) : new WebSocket(__u); ws.onopen = () => { tries = 0; while (outbox.length && ws.readyState === 1) ws.send(outbox.shift()); }; ws.onmessage = (e) => { try { const m = JSON.parse(e.data); sig.set({ data: __live(name, sig.get().data, m, q.at), loading: false, error: null }); } catch {} }; ws.onerror = () => { sig.set({ ...sig.get(), error: 'socket error' }); }; ws.onclose = (ev) => { if (dead) return; sig.set({ ...sig.get(), loading: false });
      // A 4000-4499 close is the SERVER SAYING NO — not signed in, no scope, not allowed. Retrying
      // that is a loop that never ends: a live query connects the moment its module loads, before any
      // screen has said what it is about, so an unscoped socket was refused and reconnected forever.
      // Transport failures still back off and retry; a policy refusal waits for a refetch to give
      // it what it was missing.
      if (ev && ev.code >= 4000 && ev.code < 4500) { sig.set({ ...sig.get(), error: 'socket ' + ev.code }); return; }
      setTimeout(open, Math.min(1000 * 2 ** tries++, 15000)); }; }; sig.__reopen = (next) => { params = { ...params, ...(next || {}) }; tries = 0; sig.set({ ...sig.get(), error: null });
      if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} } else { open(); } };
    open(); onCleanup(() => { dead = true; if (ws) ws.close(); }); } else {
    // THE FIRST LOAD YIELDS TO ANY REFETCH. A page that loads and then asks again with params (a key, a slug) has two
    // requests in flight; the bare one usually fails and, on a slow network, lands LAST-but-one: it cleared \`loading\`
    // and showed «not found» until the real answer came. \`__refetch\` bumps \`sig.__tok\`; a changed token drops this.
    // A SOURCE THAT WAITS (\`wait: true\`) never loads bare: its address is only complete with the params a refetch
    // brings (a slug, a key). It stays \`loading\` until that first refetch, so a page with twenty such lists sends
    // twenty requests, not forty, and none of them is a guaranteed failure competing with the real ones.
    // A QUERY LOADS WHEN SOMETHING READS IT. Every query used to start when its module loaded: a store's at app boot,
    // before any session existed, so a store list asked first, got a 401 and stayed in error for the whole visit; and a
    // list behind a closed tab loaded for nothing. The first read (a page rendering it, a get, an action) starts it.
    // A refetch that comes first marks it started, so no bare load lands on top of the scoped one.
    const __src = __SOURCES[name] && __req(__SOURCES[name], __API);
    if (__src && __src.method === 'GET') { sig.__key = __cacheKey(__src.url); const __hit = __cache.get(sig.__key); if (__hit) sig.set({ data: __hit, loading: false, error: null }); __remember(sig); }
    if (!(__src && __src.wait)) { const read = sig.get; sig.get = () => { if (!sig.__started) { sig.__started = true; if (sig.__key) sig.__key = __cacheKey(__src.url); const tok = sig.__tok || 0; __fetch(name).then((d) => { if ((sig.__tok || 0) === tok) sig.set({ data: d, loading: false, error: null }); }).catch((e) => { if ((sig.__tok || 0) === tok) sig.set({ data: [], loading: false, error: String(e) }); }); } return read(); }; } } return sig; }`;
}

// ── usage-based emission ─────────────────────────────────────────────────────────────────────────────────
// A page/store emits ONLY the runtime it actually uses: the builtins it calls, the source/persist layer if it
// reads/writes/persists, and an import naming just the runtime symbols it references. A counter (signal + effect)
// gets none of the rest. On the vite path the bundler would prune it anyway; the standalone-HTML / SSG path has
// no bundler, so this is what keeps a built static page from carrying the whole data layer it never touches.

// builtin name -> source, derived from BUILTINS_JS (one `function NAME(...) {…}` per line), so a page emits the
// closure of what it calls. The public ones are emitted as BUILTIN_PREFIX + name (`__b_date`), every call between them included; the `__` helpers
// keep their names. A page's own `date` state or `get date(…)` cannot collide, and the closure is found by those names.
const BUILTIN_LINES = BUILTINS_JS.split('\n').map((line) => line.trim()).filter(Boolean);
const PUBLIC_BUILTINS = BUILTIN_LINES.map((src) => src.slice(9, src.indexOf('('))).filter((name) => !name.startsWith('__'));
const emittedName = (name: string): string => (name.startsWith('__') ? name : BUILTIN_PREFIX + name);
const BUILTIN_SRC: { readonly [name: string]: string } = Object.fromEntries(BUILTIN_LINES.map((src) => {
  const name = src.slice(9, src.indexOf('('));
  const renamed = PUBLIC_BUILTINS.reduce((code, other) => code.replace(new RegExp(`(?<![\\w$.])${other}\\(`, 'g'), () => `${BUILTIN_PREFIX}${other}(`), src);
  return [emittedName(name), renamed];
}));
const calls = (code: string, emitted: string): boolean => new RegExp(`(?<![\\w$.])${emitted.replace(/\$/g, '\\$')}\\(`).test(code);
// which builtins each one calls, read from its own source (calendar calls time and date; every date function calls
// __date): a hand-kept table missed the next helper someone added and shipped a page calling an undefined function
const BUILTIN_DEPS: { readonly [name: string]: readonly string[] } = Object.fromEntries(
  Object.entries(BUILTIN_SRC).map(([name, src]) => [name, Object.keys(BUILTIN_SRC).filter((other) => other !== name && calls(src.slice(src.indexOf('{')), other))]),
);

function usedBuiltins(body: string): string {
  const want = new Set<string>();
  const add = (n: string): void => { if (want.has(n) || !BUILTIN_SRC[n]) return; want.add(n); (BUILTIN_DEPS[n] || []).forEach(add); };
  for (const n in BUILTIN_SRC) if (calls(body, n)) add(n);
  return Object.keys(BUILTIN_SRC).filter((n) => want.has(n)).map((n) => BUILTIN_SRC[n]).join('\n  ');
}

// localStorage helpers — emitted only for a page with `persist` state.
const PERSIST_JS = `const __loadLocal = (k, fb) => { try { const v = localStorage.getItem(k); if (v === null) return fb; const x = JSON.parse(v); /* a stored value of another SHAPE than the declared one (tampered, or an older version) is dropped, not trusted */ if (fb !== null && fb !== undefined && (Array.isArray(fb) !== Array.isArray(x) || typeof x !== typeof fb || (typeof fb === 'object' && x === null))) return fb; return x; } catch (e) { return fb; } };
  const __saveLocal = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };`;







// the runtime prelude a body needs: builtins called + persist (if it persists) + the source layer (if it
// reads/writes/sends). Detection scans the COMPILED body for the helper-call patterns the emitter produces.
function prelude(parts: EmitParts, body: string): string {
  const out: string[] = [];
  const b = usedBuiltins(body);
  if (b) out.push(b);
  if (/\b__loadLocal\(|\b__saveLocal\(/.test(body)) out.push(PERSIST_JS);
  if (/\b__script\(/.test(body)) out.push(SCRIPT_JS);
  const feeds = /\b__feed\(/.test(body);
  if (feeds || /\b__callQuery\(/.test(body)) out.push(ROWS_JS);
  if (feeds) out.push(CHANGE_JS, FEED_JS);
  if (/\b__callQuery\(/.test(body)) out.push(CALL_QUERY_JS);
  if (/\b__every\(/.test(body)) out.push(EVERY_JS);
  if (/\bquery\(|\b__fetch\(|\b__write\(|\b__crud\(|\b__refetch\(|\b__send\(/.test(body)) out.push(sourceLayer(parts));
  return out.join('\n  ');
}

// only the runtime symbols the emitted code references — `signal, effect` for a counter, not all nine. A stray
// match merely imports an unused symbol (the bundler drops it); a miss can't happen (the emitter always writes
// these as `name(` calls / `__sym` references that `\bname\b` catches).
export const RUNTIME_SYMBOLS: ReadonlyArray<string> = ['signal', 'computed', 'effect', 'untrack', 'root', 'onCleanup', '__device', '__urlRead', '__urlSet', '__watchImages', '__t', '__lang', '__langUse', '__langInit', '__langList', '__eq', '__rowKey', '__id', '__has', '__order', '__leave', '__chart', '__arc', '__drag', '__drop', '__clone', '__bind'];
function runtimeImport(code: string): string {
  const used = RUNTIME_SYMBOLS.filter((s) => new RegExp(`\\b${s}\\b`).test(code));
  return used.length ? `import { ${used.join(', ')} } from 'virtual:muten/runtime';\n` : '';
}

// One .store domain slice -> shared ESM module (state + get + actions, no DOM).
export function emitStore(parts: EmitParts): string {
  const body = [parts.stateDecls, parts.getDecls, parts.actionDecls, parts.effectDecls].join('\n');
  const pre = prelude(parts, body);
  return `${runtimeImport(pre + body)}${parts.storeImports ? parts.storeImports + '\n' : ''}${parts.externImports}

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
  // the build's own __id: counted, not random, so the same page pre-renders to the same HTML every build
  return `${runtimeScript(['__id'])}
  ${usedBuiltins(body)}
  ${needsId ? `let __seq = 0;
  function __id() { return 'id-' + (++__seq); }` : ''}
  ${needsData ? `const __DATA = ${JSON.stringify(parts.data)};
  const __UUIDS = ${JSON.stringify(parts.queryUuids)};
  const __fill = (name, rows) => { const ids = __UUIDS[name] || []; return rows.map((r) => { if (r === null || typeof r !== 'object') return r; const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; }); };
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
  const { ${RUNTIME_SYMBOLS.join(', ')} } = __rt;
  const __nodes = nodes;
  ${usedBuiltins(parts.renderBody)}
  ${parts.renderBody}
  return el_${rootId};
}`;
}

// Self-contained HTML document: runtime inlined, browser runs it directly.
// Code and CSS written inside an HTML page's <script> / <style>: a `</script` (or `</style`, or `<!--`) anywhere in them,
// even inside a string, ends the tag early and cuts the code (React's own bundle has one; so could a page's text). Escaped
// with a backslash it means the same to JS and to CSS.
export function inlineSafe(text: string, tag: 'script' | 'style'): string {
  return text.replace(tag === 'script' ? /<\/(script)/gi : /<\/(style)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

export function emitHtml(parts: EmitParts): string {
  const body = [parts.storeDecls, parts.stateDecls, parts.getDecls, parts.actionDecls, parts.componentDecls, parts.renderBody, parts.effectDecls].join('\n');
  const pre = prelude(parts, body);
  const script = `
  ${runtimeScript()}


  ${pre}

  ${parts.storeDecls}

  ${parts.stateDecls}

  ${parts.getDecls}

  ${parts.actionDecls}

  ${parts.componentDecls}

  const app = document.getElementById('app');
  app.replaceChildren();
  ${parts.renderBody}

  ${parts.effectDecls}
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${metaTags(parts.meta, parts.screen)}
<style>
  ${inlineSafe(parts.projectCss, 'style')}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">${inlineSafe(script, 'script')}</script>
</body>
</html>
`;
}
