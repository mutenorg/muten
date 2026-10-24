// probes: what the devtools know, recorded where it happens, never guessed from outside. Started once, as `muten dev`
// boots: every request (fetch, wrapped once, so a module's own fetch counts too), every redraw with its node and its time
// (the runtime's tracer), every action, every event a person caused, every state change (as a short summary, not a copy
// of the list), every text a language lacks, every error. Each list is capped: the devtools never outweigh the app.

import type { PageInstance } from '#engine/shared/types-tooling.js';

declare global {
  interface Window { __muten_stores?: { [domain: string]: { [name: string]: unknown } }; __MUTEN_DEV_TOKEN?: string; __mutenDevtoolsMounted?: boolean }
}

export interface Request { method: string; url: string; status: number; ok: boolean; ms: number; at: number; action: string; body: string; moment: number; html: boolean }
export interface Redraw { node: string; ms: number; at: number; moment: number }
export interface Change { name: string; summary: string; at: number; moment: number }
export interface Moment { n: number; label: string; kind: string; at: number; ms: number }
export interface MissingText { key: string; language: string; bare: boolean; count: number }
export interface Fault { text: string; at: number }

const CAP = { requests: 300, redraws: 4000, changes: 600, moments: 200 };
const SHORT = 60;
const JOIN_MS = 100;

/** Everything recorded, newest last; `version` moves on every record (the panel redraws only when it moved). */
export interface Recorded {
  requests: Request[]; redraws: Redraw[]; changes: Change[]; moments: Moment[];
  missing: Map<string, MissingText>; faults: Fault[]; version: number; recording: boolean;
}
export const record: Recorded = { requests: [], redraws: [], changes: [], moments: [], missing: new Map(), faults: [], version: 0, recording: true };

const push = <T>(list: T[], item: T, cap: number): void => { list.push(item); if (list.length > cap) list.splice(0, list.length - cap); record.version++; };
const now = (): number => performance.now();
const call = (holder: unknown, name: string, ...args: unknown[]): void => {
  const fn = holder && typeof holder === 'object' ? Reflect.get(holder, name) : undefined;
  if (typeof fn === 'function') Reflect.apply(fn, holder, args);
};

let moment = 0;
let action = '';
/** A new moment: the page opened, a person did something, an action ran. Redraws and requests after it belong to it. */
function begin(label: string, kind: string): void {
  if (!record.recording) return;
  const last = record.moments[record.moments.length - 1];
  if (kind === 'action' && last && last.kind === 'event' && now() - last.at < JOIN_MS) { last.label += ` → ${label}`; last.kind = 'action'; record.version++; return; }   // the click and what it fired: one moment
  moment++;
  push(record.moments, { n: moment, label, kind, at: now(), ms: 0 }, CAP.moments);
}
/** The moment `n`'s length so far: from its start to its last redraw or request. */
function extend(n: number, at: number): void { const m = record.moments[record.moments.length - 1]; if (m && m.n === n) m.ms = Math.max(m.ms, at - m.at); }

/** A short readable value: «"Ana"», «3 rows», «{ 4 fields }». */
export function short(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} row${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object' && 'loading' in value && 'data' in value) {   // a query: how it stands, not its fields
    const error: unknown = Reflect.get(value, 'error'), data: unknown = Reflect.get(value, 'data');
    return Reflect.get(value, 'loading') ? 'loading' : error ? `failed: ${String(error).slice(0, 40)}` : Array.isArray(data) ? `loaded · ${data.length} rows` : 'loaded';
  }
  if (value && typeof value === 'object') return `{ ${Object.keys(value).length} fields }`;
  const text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return text.length > SHORT ? text.slice(0, SHORT - 1) + '…' : text;
}

function wrapFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const started = now(), by = action, at = moment;
    if (url.includes('/_muten/') || url.includes('/__muten_')) return original(input, init);   // the devtools' own questions
    try {
      const response = await original(input, init);
      let body = '';
      if (!response.ok) { try { body = (await response.clone().text()).slice(0, 2000); } catch { body = ''; } }
      const html = response.ok && /text\/html/.test(response.headers.get('content-type') || '') && !/\.html?($|\?)/.test(url);   // asked for data, got a web page
      push(record.requests, { method, url, status: response.status, ok: response.ok, ms: now() - started, at: started, action: by, body, moment: at, html }, CAP.requests);
      extend(at, now());
      return response;
    } catch (error) {
      push(record.requests, { method, url, status: 0, ok: false, ms: now() - started, at: started, action: by, body: error instanceof Error ? error.message : String(error), moment: at, html: false }, CAP.requests);
      throw error;
    }
  };
}

/** What a person just did, in words: «clicked «Guardar»», «typed in «Precio»». */
function described(event: Event): string {
  const target = event.target instanceof Element ? event.target : null;
  const named = target?.closest('button, a, [role=button], label, input, select, textarea');
  const words = (named?.getAttribute('aria-label') || named?.textContent || named?.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  const verb = event.type === 'click' ? 'clicked' : event.type === 'input' ? 'typed in' : 'pressed a key in';
  return words ? `you ${verb} «${words}»` : `you ${verb} the page`;
}

/** Watches every state of the page and the stores, recording a short summary of each change. */
function watchStates(): () => void {
  const rt = window.__muten_rt, page = window.__muten_page;
  const root = rt && Reflect.get(rt, 'root'), effect = rt && Reflect.get(rt, 'effect');
  if (typeof root !== 'function' || typeof effect !== 'function') return () => {};
  const scopes: Array<[string, { [name: string]: unknown }]> = [['', page?.ctx || {}], ...Object.entries(window.__muten_stores || {}).map(([domain, ctx]): [string, { [name: string]: unknown }] => [domain + '.', ctx])];
  const made = Reflect.apply(root, rt, [() => {
    for (const [prefix, ctx] of scopes) for (const [name, ref] of Object.entries(ctx)) {
      if (!ref || typeof ref !== 'object') continue;
      const get = Reflect.get(ref, 'get');
      if (typeof get !== 'function' || typeof Reflect.get(ref, 'set') !== 'function') continue;
      let first = true, last: unknown;
      Reflect.apply(effect, rt, [() => {
        const value: unknown = Reflect.apply(get, ref, []);
        if (first) { first = false; last = value; return; }
        const before = last; last = value;
        const summary = Array.isArray(before) && Array.isArray(value) ? `${value.length - before.length >= 0 ? '+' : ''}${value.length - before.length} (${value.length} rows)` : `${short(before)} → ${short(value)}`;
        push(record.changes, { name: prefix + name, summary, at: now(), moment }, CAP.changes);
      }]);
    }
  }]);
  const dispose = made && typeof made === 'object' ? Reflect.get(made, 'dispose') : undefined;
  return () => { if (typeof dispose === 'function') Reflect.apply(dispose, made, []); };
}

let watching: PageInstance | undefined;
let stopWatching: () => void = () => {};

/** Starts every probe (once). */
export function startProbes(): void {
  wrapFetch();
  const rt = window.__muten_rt;
  call(rt, '__traceWith', (node: string, ms: number) => {
    if (!record.recording) return;
    push(record.redraws, { node, ms, at: now(), moment }, CAP.redraws);
    extend(moment, now());
  });
  call(rt, '__missingWith', (key: string, language: string, bare: boolean) => {
    const id = language + ':' + key, seen = record.missing.get(id);
    if (seen) seen.count++; else { record.missing.set(id, { key, language, bare, count: 1 }); record.version++; }
  });
  const dispatch = rt ? Reflect.get(rt, '__dispatch') : undefined;   // the compiler announces each action in dev
  if (rt) Reflect.set(rt, '__dispatch', (name: string) => {
    if (typeof dispatch === 'function') Reflect.apply(dispatch, rt, [name]);
    action = name;
    begin('action ' + name, 'action');
    queueMicrotask(() => { if (action === name) action = ''; });
  });
  for (const type of ['click', 'input', 'keydown']) window.addEventListener(type, (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#muten-devtools-host')) return;
    if (type === 'keydown' && event instanceof KeyboardEvent && event.key.length > 1 && event.key !== 'Enter') return;
    begin(described(event), 'event');
  }, true);
  for (const type of ['error', 'unhandledrejection']) window.addEventListener(type, (event) => {
    const error = event instanceof ErrorEvent ? event.error : event instanceof PromiseRejectionEvent ? event.reason : null;
    const text = error instanceof Error ? error.stack || error.message : String(error ?? '');
    if (!text || /^ResizeObserver loop/.test(text)) return;
    push(record.faults, { text, at: now() }, 50);
  });
  // a new page: its moment, and its states watched afresh
  setInterval(() => {
    const page = window.__muten_page;
    if (page === watching) return;
    watching = page;
    stopWatching();
    stopWatching = watchStates();
    begin(`opened ${location.pathname}`, 'load');
  }, 200);
}

/** How long the page at `path` took to be ready, from the runtime's marks (the last navigation to it). */
export function readiness(): { path: string; ms: number } | null {
  const ready = performance.getEntriesByName('muten:ready').pop();
  if (!ready || !(ready instanceof PerformanceMark)) return null;
  const go = performance.getEntriesByName('muten:go').filter((mark) => mark.startTime <= ready.startTime).pop();
  const path = typeof ready.detail === 'string' ? ready.detail : location.pathname;
  return { path, ms: ready.startTime - (go ? go.startTime : 0) };
}
