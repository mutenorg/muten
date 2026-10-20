// runtime-snippets: the small runtime pieces a page carries only when its code calls them (emit.ts prelude): a query of a
// function, a poll, a script's global, what SDKs answer with, a live feed. Each is JS text, written into the page.

// A query whose data comes from a function (`hits = query lookup(q) : list<Hit>`): asked when the page mounts and again
// whenever an argument changes; an answer that arrives after a newer question is dropped. The function may return a
// value or a promise (any npm SDK). `live`: it is a subscription, called with a callback last and returning the way to
// stop; each value it pushes becomes the data, and it is stopped on leaving the page (or when an argument changes).
export const CALL_QUERY_JS = `function __callQuery(args, fn, live, empty) {
    const sig = signal({ data: empty, loading: true, error: null });
    let turn = 0, stop = null;
    const fail = (e) => String(e && e.message ? e.message : e);
    const ask = (values) => {
      const mine = ++turn;
      __stop(stop); stop = null;
      untrack(() => sig.set({ data: sig.get().data, loading: true, error: null }));
      try {
        const failed = (e) => { if (mine === turn) sig.set({ data: sig.get().data, loading: false, error: fail(e) }); };
        if (live) { stop = fn(...values, (v) => { if (mine !== turn) return; try { sig.set({ data: __sdkRows(v) ?? empty, loading: false, error: null }); } catch (e) { failed(e); } }); return; }
        Promise.resolve(fn(...values)).then(__sdkRows).then((v) => { if (mine === turn) sig.set({ data: v ?? empty, loading: false, error: null }); }, failed);
      } catch (e) { sig.set({ data: sig.get().data, loading: false, error: fail(e) }); }
    };
    let last = [];
    effect(() => { last = args(); untrack(() => ask(last)); });
    onCleanup(() => { turn++; __stop(stop); });
    sig.__rerun = () => ask(last);
    return sig;
  }`;

// `query x every 30s`: asked again on that beat while the page is open and the tab is visible; coming back to the tab
// after longer than the beat asks at once. A function query asks itself again; a source query repeats its last params.
export const EVERY_JS = `function __every(name, sig, ms) {
    let last = Date.now();
    const again = () => { last = Date.now(); if (typeof sig.__rerun === 'function') sig.__rerun(); else __refetch(name, sig.__params || {}, sig); };
    const timer = setInterval(() => { if (!document.hidden) again(); }, ms);
    const back = () => { if (!document.hidden && Date.now() - last >= ms) again(); };
    document.addEventListener('visibilitychange', back);
    onCleanup(() => { clearInterval(timer); document.removeEventListener('visibilitychange', back); });
  }`;

// `use google from script "https://…"`: the script is added once, the first time anything of it is called; a call down any
// path (`google.accounts.id.initialize({ … })`) waits for it and runs with its own `this`, answering a promise
export const SCRIPT_JS = `function __script(url, name) {
    const ready = () => { const all = globalThis.__muScripts || (globalThis.__muScripts = {}); if (!all[url]) all[url] = new Promise((done, fail) => { if (globalThis[name]) return done(globalThis[name]); const tag = document.createElement('script'); tag.src = url; tag.async = true; tag.onload = () => done(globalThis[name]); tag.onerror = () => fail(new Error('could not load ' + url)); document.head.appendChild(tag); }); return all[url]; };
    const at = (path) => new Proxy(function () {}, { get: (_, key) => (key === 'then' ? undefined : at([...path, key])), apply: (_, __, args) => ready().then((root) => { let self = globalThis, fn = root; for (const key of path) { self = fn; fn = fn[key]; } if (typeof fn !== 'function') throw new Error(name + '.' + path.join('.') + ' is not a function'); return fn.apply(self, args); }) });
    return at([]);
  }`;

// what the big SDKs answer with, read as muten data: { data, error } (Supabase and most REST clients; the error becomes
// .error), a Firestore snapshot of many (docs: rows with their id) or of one (exists/data), and anything else as it is
export const ROWS_JS = `function __sdkRows(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    if ('data' in v && 'error' in v) { if (v.error) throw v.error; return v.data; }
    if (Array.isArray(v.docs) && v.docs.every((d) => d && typeof d.data === 'function')) return v.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (typeof v.data === 'function' && typeof v.exists === 'function') return v.exists() ? { id: v.id, ...v.data() } : null;
    return v;
  }
  function __stop(stop) { try { if (typeof stop === 'function') stop(); else if (stop && typeof stop.unsubscribe === 'function') stop.unsubscribe(); } catch (e) {} }`;

// one change, applied to what a state holds: a Supabase postgres_changes event (INSERT/UPDATE add or replace the row by
// id, DELETE takes it out), muten's own { upsert, remove }, a whole list (it is the list now), one row with an id (added
// or replaced), or a single value (a user, a count: it is the value now)
export const CHANGE_JS = `function __change(cur, v) {
    const key = (r) => (r && typeof r === 'object' ? r.id : undefined);
    const list = Array.isArray(cur) ? cur : [];
    const upsert = (rows) => { const out = list.slice(); for (const r of rows) { const at = out.findIndex((x) => key(x) !== undefined && key(x) === key(r)); if (at >= 0) out[at] = { ...out[at], ...r }; else out.push(r); } return out; };
    const drop = (from, ids) => from.filter((x) => !ids.includes(key(x)));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.eventType === 'string' && ('new' in v || 'old' in v)) return v.eventType === 'DELETE' ? (Array.isArray(cur) ? drop(list, [key(v.old)]) : null) : (Array.isArray(cur) ? upsert([v.new]) : v.new);
      if ('upsert' in v || 'remove' in v) return drop(v.upsert ? upsert([].concat(v.upsert)) : list, v.remove == null ? [] : [].concat(v.remove));
    }
    const rows = __sdkRows(v);
    if (Array.isArray(rows)) return rows;
    return Array.isArray(cur) && key(rows) !== undefined ? upsert([rows]) : rows;
  }`;

// `live <feed>`: the package's own subscription, opened once with muten's \`change\` as its callback, closed with the page
// (a stop function or an object with unsubscribe(), as Supabase and Firebase hand back). A change that comes after the
// page left is dropped: a socket shared with other pages keeps its listener, but it no longer writes anything.
export const FEED_JS = `function __feed(sig, isQuery, open) {
    let dead = false, stop = null;
    const now = () => untrack(() => (isQuery ? sig.get().data : sig.get()));
    const failed = (e) => { if (isQuery) sig.set({ data: now(), loading: false, error: String(e && e.message ? e.message : e) }); };
    const change = (v) => { if (dead) return; try { const next = __change(now(), v); if (isQuery) sig.set({ data: next, loading: false, error: null }); else sig.set(next); } catch (e) { failed(e); } };
    try { stop = untrack(() => open(change)); } catch (e) { failed(e); }
    onCleanup(() => { dead = true; __stop(stop); });
  }`;
