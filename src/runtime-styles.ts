// runtime-styles: a page's own stylesheet, linked before the page shows (css-routes.ts writes one per route and lists
// them in a <meta name="muten-route-css">). A sheet already linked (a page visited before, or the one a pre-rendered
// HTML carries) is not fetched again; it is moved last, so the page on screen always has its own rules after every
// other sheet, in their original order. Once the whole sheet is in (asked for after the first page), no page needs its
// own. Without the tag (dev, or one stylesheet for the whole app) this does nothing.
const META = 'muten-route-css';
const WAIT_MS = 4000;   // a sheet that never answers does not keep the page from showing
let sheets: { [page: string]: string } | null = null;

function readSheets(): { [page: string]: string } {
  const out: { [page: string]: string } = {};
  const meta = document.querySelector(`meta[name="${META}"]`);
  if (!meta) return out;
  try {
    const parsed: unknown = JSON.parse(meta.getAttribute('content') || '{}');
    if (parsed && typeof parsed === 'object') for (const [page, href] of Object.entries(parsed)) if (typeof href === 'string') out[page] = href;
  } catch { /* a broken tag: no sheets, the common one still styles the app */ }
  return out;
}

// the whole sheet (css-routes.ts, listed under "*"): once it is in, no page needs a sheet of its own
let whole: 'none' | 'asked' | 'in' = 'none';
const IDLE_MS = 1500;   // without requestIdleCallback, asked for this long after the first page

/** Once the first page is up: the sheet with every rule, asked for when the browser is idle. Every later page finds
 *  its rules in it, so moving between pages downloads no CSS. */
export function wholeLater(): void {
  if (whole !== 'none' || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  if (!sheets) sheets = readSheets();
  const href = sheets['*'];
  if (!href) return;
  whole = 'asked';
  const ask = (): void => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = (): void => { whole = 'in'; };
    link.onerror = (): void => { whole = 'none'; link.remove(); };   // the pages' own sheets go on working
    document.head.appendChild(link);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(ask, { timeout: IDLE_MS * 2 });
  else setTimeout(ask, IDLE_MS);
}

/** Starts downloading `page`'s stylesheet without applying it (the reader may open that page next). */
export function warmStyles(page?: string): void {
  if (!page || typeof document === 'undefined' || whole === 'in') return;
  if (!sheets) sheets = readSheets();
  const href = sheets[page];
  if (!href || document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'style';
  link.href = href;
  document.head.appendChild(link);
}

/** Resolves once `page`'s stylesheet is linked, loaded and last in <head>. */
export function routeStyles(page?: string): Promise<void> {
  if (!page || typeof document === 'undefined' || whole === 'in') return Promise.resolve();
  if (!sheets) sheets = readSheets();
  // a written-out page defers the whole sheet itself (prerender.ts): the page waits for that one, not its own
  const all = sheets['*'];
  const deferred = all ? [...document.querySelectorAll('link[rel="stylesheet"]')].find((link) => link.getAttribute('href') === all) : undefined;
  if (deferred instanceof HTMLLinkElement) {
    whole = 'asked';
    return new Promise<void>((done) => {
      const finish = (): void => { whole = 'in'; done(); };
      if (deferred.sheet && deferred.media !== 'print') { finish(); return; }
      deferred.addEventListener('load', finish, { once: true });
      deferred.addEventListener('error', () => { whole = 'none'; done(); }, { once: true });
      setTimeout(done, WAIT_MS);
    });
  }
  const href = sheets[page];
  if (!href) return Promise.resolve();
  const linked = [...document.querySelectorAll('link[rel="stylesheet"]')].find((link) => link.getAttribute('href') === href);
  if (linked) { document.head.appendChild(linked); return Promise.resolve(); }
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  const ready = new Promise<void>((done) => {
    link.onload = (): void => done();
    link.onerror = (): void => done();
    setTimeout(done, WAIT_MS);
  });
  document.head.appendChild(link);
  return ready;
}
