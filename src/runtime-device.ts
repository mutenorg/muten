// runtime-device: `device`, the browser as a store a page reads like any other (`when device.online`, `device.width`,
// `class("motion" when not device.reducedMotion)`). Each member is a signal made the first time a page reads it and
// kept in step with the browser from then on: the apps used to write a `.ts` per fact (lockScroll, gateMotion,
// watchScroll…). Off the browser (the build's pre-render) every member reads its quiet default.
import { signal } from './runtime-signals.js';
import type { Signal } from './engine/shared/types.js';

type Reader = () => string | number | boolean;
interface Source { read: Reader; listen: (update: () => void) => void; fallback: string | number | boolean }

const media = (query: string): Source => ({
  read: () => matchMedia(query).matches,
  listen: (update) => { matchMedia(query).addEventListener('change', update); },
  fallback: false,
});
const onWindow = (events: string[], read: Reader, fallback: string | number | boolean): Source => ({
  read, fallback, listen: (update) => { for (const event of events) addEventListener(event, update, { passive: true }); },
});

// the page's scroll, read once per frame at most: how far down, and which way it last went (a bar that hides going down)
let lastY = 0;
let lastDir = '';
const scrollDir = (): string => { const y = scrollY; if (Math.abs(y - lastY) > 4) { lastDir = y > lastY ? 'down' : 'up'; lastY = y; } return lastDir; };

// keyed exactly by vocab DEVICE_MEMBERS (test/device.ts holds the two together)
const SOURCES: { readonly [member: string]: Source } = {
  online: onWindow(['online', 'offline'], () => navigator.onLine, true),
  dark: media('(prefers-color-scheme: dark)'),
  reducedMotion: media('(prefers-reduced-motion: reduce)'),
  touch: media('(pointer: coarse)'),
  width: onWindow(['resize'], () => innerWidth, 1024),
  height: onWindow(['resize'], () => innerHeight, 768),
  visible: { read: () => !document.hidden, listen: (update) => { document.addEventListener('visibilitychange', update); }, fallback: true },
  lang: { read: () => (navigator.language || 'en').slice(0, 2).toLowerCase(), listen: (update) => { addEventListener('languagechange', update); }, fallback: 'en' },
  // the time, in milliseconds, a second at a time (a countdown, «hace un momento»): it ticks only once a page reads it
  now: { read: () => Date.now(), listen: (update) => { setInterval(update, 1000); }, fallback: 0 },
  scrollY: onWindow(['scroll'], () => Math.round(scrollY), 0),
  scrollDir: onWindow(['scroll'], scrollDir, ''),
};

const made = new Map<string, Signal<string | number | boolean>>();

/** The signal behind `device.<member>`. */
export function __device(member: string): Signal<string | number | boolean> {
  let sig = made.get(member);
  if (sig) return sig;
  const source = SOURCES[member];
  const live = typeof window !== 'undefined' && typeof document !== 'undefined' && !!source;
  sig = signal(live ? source.read() : source ? source.fallback : false);
  const own = sig;
  if (live) source.listen(() => own.set(source.read()));
  made.set(member, sig);
  return sig;
}
