// runtime-island: an island (React, Vue, Svelte, Solid, a lazy Custom) wakes when it is about to be seen, or when its
// `wake` says: `load` (as the page opens), `idle` (once the browser has nothing else to do), `media "(…)"` (while the
// query holds: a desktop-only widget never loads on a phone). A page with a React component used to import React
// (and the component's library) before a line of the page ran: Storio's landing home waited for 130 KB gz of React and
// motion for headings that animate far below the first screen. Now the page mounts at once, and each island asks for
// React and its component when its place nears the screen (a screen's height ahead, so it is drawn before it shows).
//   · an island on the first screen wakes at once, and a written-out copy (runtime-snap.ts) waits for it before it goes;
//     one further down wakes too when it is near, but the copy never waits for it (React for a section below held the
//     whole app back: ready in 425 ms instead of 143 on Storio's home);
//   · while a page is drawn for prerender (prerender.ts sets __mutenWakeAll), every island wakes: the copy is complete;
//   · an island whose page is left before it woke never loads.
// The island's own box is `display: contents` (no box to observe), so the nearest box around it is watched.
const AHEAD = '100% 0px';   // a screen's height before it shows
const waking = new Set<Promise<void>>();

declare global { interface Window { __mutenWakeAll?: boolean } }

/** The nearest element that has a box of its own, `host` first: a React island's is `display: contents`, and so may be
 *  the wrappers around it (an element without a box never crosses the screen for an IntersectionObserver); a lazy
 *  Custom has its own, and watching its parent woke it with the page. */
function withBox(host: Element): Element {
  let at: Element | null = host;
  while (at && at.parentElement && getComputedStyle(at).display === 'contents') at = at.parentElement;
  return at || host;
}

function onScreen(box: Element): boolean {
  const rect = box.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < (innerHeight || 0);
}

function nearScreen(box: Element): boolean {
  const rect = box.getBoundingClientRect();
  const height = innerHeight || 0;
  return rect.bottom >= -height && rect.top <= height * 2;
}

type Start = (go: () => void, host: Element, query: string) => () => void;

// how each `wake` mode starts an island; each returns how to stop waiting. `visible` (the default) is __island's own.
const STARTS: { readonly [mode: string]: Start } = {
  load: (go) => { go(); return () => {}; },
  idle: (go) => {
    if (typeof requestIdleCallback === 'function') { const handle = requestIdleCallback(go, { timeout: 2000 }); return () => cancelIdleCallback(handle); }
    const timer = setTimeout(go, 200); return () => clearTimeout(timer);
  },
  media: (go, _host, query) => {
    const list = matchMedia(query);
    if (list.matches) { go(); return () => {}; }
    const change = (event: MediaQueryListEvent): void => { if (event.matches) { list.removeEventListener('change', change); go(); } };
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  },
};

/** Runs `wake` (which loads and renders the island) when its mode says (`visible`: once `host`'s place nears the
 *  screen; `load`, `idle`, `media`: see STARTS); returns how to give up. */
export function __island(host: Element, wake: () => Promise<void>, when = 'visible', query = ''): () => void {
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    // a library that fails to load or render leaves its place empty and says why; the page goes on
    const work = wake().catch((error: unknown) => { console.error('[muten] a React island did not wake:', error); });
    // only an island on the screen right now holds a written-out copy up: one a screen below may load later
    if (onScreen(withBox(host))) { waking.add(work); void work.then(() => waking.delete(work)); }
  };
  const everything = typeof window !== 'undefined' && window.__mutenWakeAll === true;
  if (everything || (when === 'visible' && typeof IntersectionObserver === 'undefined')) { go(); return () => { done = true; }; }
  const start = STARTS[when];
  if (start) { const stop = start(go, host, query); return () => { done = true; stop(); }; }
  // laid out in the next frame (the page is being built now): on the first screen, it wakes at once
  let watcher: IntersectionObserver | null = null;
  const frame = requestAnimationFrame(() => {
    if (done) return;
    const box = withBox(host);
    if (nearScreen(box)) { go(); return; }
    watcher = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { watcher?.disconnect(); go(); } }, { rootMargin: AHEAD });
    watcher.observe(box);
  });
  return () => { done = true; cancelAnimationFrame(frame); watcher?.disconnect(); };
}

/** Resolves once every island that has started waking has drawn (a written-out copy waits for them before it goes). */
export function islandsDrawn(): Promise<void> {
  return new Promise((done) => requestAnimationFrame(() => { void Promise.all([...waking]).then(() => done()); }));
}
