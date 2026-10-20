// runtime-media: every muten Image says how its loading went, so CSS can draw it, with no Custom: `data-state="loaded"`
// once it arrives and `data-state="error"` when it never does (a stored URL that 404s). One listener on the document
// (load and error do not bubble, but they are seen on the way down), so images built, cloned or added later are all
// covered. <html data-mu-images> says the watcher runs: only then is an image with no state yet «loading», so a page
// without JavaScript never shows a skeleton that never ends.
//   [data-mu-images] .mu-image:not([data-state]) { background: var(--muted); }   ← loading (a skeleton)
//   .mu-image[data-state="loaded"] { animation: fade-in .2s }                      ← arrived
//   .mu-image[data-state="error"] { visibility: hidden }                           ← no broken icon
const IMAGE_CLASS = 'mu-image';

function settle(event: Event, state: string): void {
  const target = event.target;
  if (target instanceof HTMLImageElement && target.classList.contains(IMAGE_CLASS)) target.dataset.state = state;
}

/** Start watching muten images (once per page). */
export function __watchImages(): void {
  if (typeof document === 'undefined' || !document.documentElement || document.documentElement.hasAttribute('data-mu-images')) return;
  document.documentElement.setAttribute('data-mu-images', '');
  document.addEventListener('load', (event) => settle(event, 'loaded'), true);
  document.addEventListener('error', (event) => settle(event, 'error'), true);
  // the ones that finished before the watcher started (cached, or in the first HTML)
  for (const img of document.querySelectorAll<HTMLImageElement>(`img.${IMAGE_CLASS}`)) if (img.complete) img.dataset.state = img.naturalWidth ? 'loaded' : 'error';
}
