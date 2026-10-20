// runtime-url: `url`, the address bar as a store. `url.s` is the `?s=` of the address (empty when it has none) and
// `url.path` its path, kept in step with Back, Forward and every navigation; `url.set({ s: "pagos" })` writes them as a
// new step of the history, so Back undoes it (a section opened on a phone closes with the phone's Back). An empty value
// takes the parameter out.
import { signal } from './runtime-signals.js';
import type { Signal } from './engine/shared/types.js';

const PATH = 'path';
let address: Signal<string> | null = null;

// the address as a signal, made the first time a page reads it: every way the address changes refreshes it
function current(): Signal<string> {
  if (address) return address;
  const own = signal(typeof location === 'undefined' ? 'http://localhost/' : location.href);
  address = own;
  if (typeof window === 'undefined') return own;
  const refresh = (): void => own.set(location.href);
  addEventListener('popstate', refresh);
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = (data: unknown, unused: string, next?: string | URL | null): void => { push(data, unused, next); refresh(); };
  history.replaceState = (data: unknown, unused: string, next?: string | URL | null): void => { replace(data, unused, next); refresh(); };
  return own;
}

/** `url.s` (the `?s=` parameter, or '') and `url.path`. */
export function __urlRead(name: string): string {
  const here = new URL(current().get());
  return name === PATH ? here.pathname : here.searchParams.get(name) ?? '';
}

/** `url.set({ s: "pagos" })`: a new step of the history with those parameters (empty takes one out). */
export function __urlSet(values: { [name: string]: unknown }): void {
  current();
  const next = new URL(location.href);
  for (const [name, value] of Object.entries(values || {})) {
    if (value === null || value === undefined || value === '') next.searchParams.delete(name);
    else next.searchParams.set(name, String(value));
  }
  if (next.href === location.href) return;
  const state: { muDepth?: number } | null = history.state;
  history.pushState({ ...(state || {}), muDepth: (state && typeof state.muDepth === 'number' ? state.muDepth : 0) + 1 }, '', next.pathname + next.search + next.hash);
}
