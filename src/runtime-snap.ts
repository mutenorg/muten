// runtime-snap: the hand-over from a page written out at build time (prerender.ts) to the app. The written-out copy
// sits in #app inside `<div data-muten-snap="/route">`, styled by the rules inlined in its <head>, while the app
// starts. The app mounts beside it, hidden (the page's inline style hides whatever follows the copy) but laid out, so
// its widgets measure right; once the app's page is on screen, its stylesheets are in and the islands of the first screen
// have drawn, the copy goes in one frame, its inline CSS with it. Same markup, same CSS: nothing moves.
//   · a copy written for another address (a host that served it for a path it does not have), or in a language the
//     app will not speak to this reader (hidden before it painted: prerender.ts LANG_GUARD), goes at once;
//   · while the copy is up, a link is the browser's: every page is written out, so the browser just opens it;
//   · the stylesheets a written-out page defers (`data-muten-later`, media="print") are switched on as the app starts.
import { islandsDrawn } from './runtime-island.js';

const SNAP = 'data-muten-snap';
const LATER = 'link[data-muten-later]';
const WAIT_MS = 3000;   // past this, the app takes over whatever is still loading

// (a document without querySelector is a test's stand-in DOM: no copy there)
const copy = (): Element | null => (typeof document === 'undefined' || typeof document.querySelector !== 'function' ? null : document.querySelector(`#app > [${SNAP}]`));

/** Whether a written-out copy is still on screen. */
export function snapshotShowing(): boolean {
  return copy() !== null;
}

const sheetLoaded = (link: HTMLLinkElement): Promise<void> => new Promise((done) => {
  if (link.sheet) { done(); return; }
  link.addEventListener('load', () => done(), { once: true });
  link.addEventListener('error', () => done(), { once: true });
});
const capped = (work: Promise<unknown>): Promise<void> => Promise.race([work.then(() => undefined), new Promise<void>((done) => setTimeout(done, WAIT_MS))]);

/** At start: a copy of another address goes; the deferred stylesheets go on. Resolves once they are in. */
export function startHandOver(): Promise<void> {
  const found = copy();
  if (!found) return Promise.resolve();
  // written for another address, or in a language the app will not speak to this reader (prerender.ts LANG_GUARD)
  if (found.getAttribute(SNAP) !== location.pathname || document.documentElement.hasAttribute('data-muten-other-lang')) found.remove();
  const later = [...document.querySelectorAll<HTMLLinkElement>(LATER)];
  for (const link of later) { link.media = 'all'; link.removeAttribute('data-muten-later'); }
  return capped(Promise.all(later.map(sheetLoaded)));
}

/** Once the app's page is on screen: the copy goes, after the islands of the first screen, in the next frame. Not after
 *  the fonts: the copy and the app are set in the same ones (a late font changes both alike), and waiting for one from
 *  another host kept the copy up, unanswering, for seconds. */
export function releaseSnapshot(): void {
  if (!copy()) { dropCritical(); return; }
  void capped(islandsDrawn()).then(() => requestAnimationFrame(() => { copy()?.remove(); dropCritical(); }));
}

/** The copy's inline CSS goes with the copy. It is one page's rules, written after every stylesheet: left in, it won
 *  over rules of the next page's that come later in the app's CSS (Storio's /pricing, reached from the home, showed its
 *  heading and its toggle with the home's rules). Its stylesheets are in by now: the router waited for them. */
function dropCritical(): void {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  document.querySelector('style[data-muten-critical]')?.remove();
}
