// runtime-nav: the router's dealings with the browser, kept apart from what it mounts.
//   · which click is the app's to handle: a plain left click on a link to this site. A ctrl/cmd/shift/alt click, a
//     middle click or one a handler already took is the browser's (a new tab, a new window, a download).
//   · loading a page's code without leaving the reader stuck: the import is tried twice, and when it still fails the
//     browser loads the address itself. A deploy replaces the chunk files, so a tab opened before it asks for a name
//     that no longer exists; a full load brings the new index.html and its new names. Once per address, so a site
//     that is really down shows its error instead of reloading forever.
//   · starting the next page before the click: a pointer resting on a link, a finger touching it or the keyboard
//     reaching it asks for that route's code and stylesheet, so by the time the click lands they are on their way or
//     in. Not on a connection that asks to save data.
const RETRY_MS = 400;
const HOVER_MS = 65;   // a pointer passing over a link on its way elsewhere does not ask for anything
const RELOADED = 'muten:reloaded';

/** The internal address a click should open in the app, or null when the browser should handle it. */
export function appHref(event: MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const link = target.closest('a');
  return link ? internalHref(link) : null;
}

function internalHref(link: Element): string | null {
  const href = link.getAttribute('href');
  if (!href || href[0] === '#' || link.getAttribute('target') || link.hasAttribute('download') || /^[a-z]+:|^\/\//i.test(href)) return null;
  return href;
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** `load()` once more after a beat if it fails; if it still fails, the browser opens `path` itself (once). */
export function loadOrReload<T>(load: () => Promise<T>, path: string): Promise<T> {
  return load().catch(() => wait(RETRY_MS).then(load)).catch((error: unknown) => {
    let tried = '';
    try { tried = sessionStorage.getItem(RELOADED) || ''; } catch { /* private mode: no memory, still one try per load */ }
    if (tried !== path) {
      try { sessionStorage.setItem(RELOADED, path); } catch { /* as above */ }
      location.assign(path);
    }
    throw error;
  });
}

/** Called once a page is on screen: the next failure at this address may reload again. */
export function landed(): void {
  try { sessionStorage.removeItem(RELOADED); } catch { /* private mode */ }
}

// navigator.connection is not in every browser (nor in the DOM types): read as unknown, narrowed
const savesData = (): boolean => {
  const connection: unknown = Reflect.get(navigator, 'connection');
  return typeof connection === 'object' && connection !== null && 'saveData' in connection && connection.saveData === true;
};

/** Asks for a route's code and stylesheet when the reader shows they may open it. `warm` does the asking. */
export function warmOnIntent(warm: (path: string) => void): void {
  if (typeof addEventListener !== 'function' || typeof navigator === 'undefined' || savesData()) return;
  const asked = new Set<string>();
  const ask = (event: Event): void => {
    const target = event.target;
    const link = target instanceof Element ? target.closest('a') : null;
    const href = link ? internalHref(link) : null;
    const path = href ? href.split(/[?#]/)[0] : '';
    if (!path || path === location.pathname || asked.has(path)) return;
    asked.add(path);
    warm(path);
  };
  let resting: ReturnType<typeof setTimeout> | undefined;
  // on the window, where the router hears clicks: every one of these bubbles up to it
  addEventListener('pointerover', (event) => { clearTimeout(resting); resting = setTimeout(() => ask(event), HOVER_MS); }, { passive: true });
  addEventListener('pointerout', () => clearTimeout(resting), { passive: true });
  addEventListener('touchstart', ask, { passive: true });
  addEventListener('focusin', ask);
}

// muten.config `routes { preload "intent" | "visible" | "idle" | "none" }`, in a <meta> muten writes into index.html
const PRELOAD_META = 'muten-preload';
const preloadMode = (): string => (typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector(`meta[name="${PRELOAD_META}"]`)?.getAttribute('content') || '' : '') || 'intent';

/** Warms the routes a reader may open next, the way `routes { preload }` says: on intent (a pointer resting on a link,
 *  a touch, focus; the default), also every link that comes into view (`visible`), also every route once the browser is
 *  idle (`idle`, the routes with no :param), or never (`none`). Saving data turns it all off. */
export function warmRoutes(warm: (path: string) => void, paths: string[]): void {
  const mode = preloadMode();
  if (mode === 'none' || typeof navigator === 'undefined' || savesData()) return;
  warmOnIntent(warm);
  const asked = new Set<string>([location.pathname]);
  const once = (path: string): void => { if (!asked.has(path)) { asked.add(path); warm(path); } };
  if (mode === 'idle') {
    const all = (): void => { for (const path of paths) if (!path.includes(':')) once(path); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(all, { timeout: 3000 }); else setTimeout(all, 1500);
  }
  if (mode === 'visible' && typeof IntersectionObserver === 'function' && typeof MutationObserver === 'function') {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        seen.unobserve(entry.target);
        const href = entry.target instanceof HTMLAnchorElement ? internalHref(entry.target) : null;
        if (href) once(href.split(/[?#]/)[0]);
      }
    });
    const watchLinks = (root: ParentNode): void => { for (const link of root.querySelectorAll('a[href]')) seen.observe(link); };
    watchLinks(document);
    new MutationObserver((changes) => { for (const change of changes) for (const node of change.addedNodes) if (node instanceof Element) { if (node.matches('a[href]')) seen.observe(node); watchLinks(node); } })
      .observe(document.body, { childList: true, subtree: true });
  }
}
