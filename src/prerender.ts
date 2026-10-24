// prerender: every page of a bundled app drawn once at build time and written out as its own HTML, so a person reads it
// before a line of the app's JavaScript runs, and a crawler that runs none (link previews, the crawlers behind AI
// answers) reads it at all. `prerender { }` in muten.config turns it on; Storio wrote all of it by hand (a snapshot
// script, a critical-CSS pass, a deferred boot and a hand-over in index.html), with the bugs it paid for in each.
//   · DRAWN BY THE APP ITSELF, in a headless Chrome on the built files, with the network closed: only the build and the
//     hosts in `allow` (and Google Fonts) answer, so a build never reaches an API. A request for data is held, so a
//     page with live data is written out as a reader first sees it, loading; anything else from elsewhere fails. With motion reduced, a page settles at its
//     first state. What it drew is the page's real content, never a page shown only to robots.
//   · NOTHING LAID OUT FOR ANOTHER SCREEN: an element a script laid out differently on a desktop and on a phone (a
//     bar's measured positions, `data-compact`) keeps its place in the copy but is not shown until the app has
//     measured it on the reader's screen (prerender-vary.ts).
//   · WRITTEN SAFE: no scripts, frames, media or handlers in the copy; a picture no first screen shows (desktop or
//     phone) without its address (it would take the bandwidth the first screen needs, for an instant's view); the
//     symbols its icons draw from, when the page keeps them outside #app, carried along.
//   · ITS HEAD: the page's title, description and og: tags, and <html lang>, as the app set them.
//   · ITS CSS INLINE: only the rules its markup uses (its route's sheet and the styles the app put in <head> as it ran,
//     pruned against its HTML); the whole stylesheet stops blocking the first paint and goes on as the app starts.
//   · THE APP AFTER THE PAINT: the boot is asked for once the browser has drawn a frame of the copy (two animation
//     frames; never later than 2.5 s, for a tab in the background), together with every file the page needs. Not on
//     the browser's first-contentful-paint report, nor after the fonts: while a font loads, that report can come
//     seconds late, and the copy, which a button on it cannot answer, stayed up that long. The loader is the same on
//     every page (its list is data), so a Content-Security-Policy allows it by one hash.
// Left as the shell: a route with a :param, one that redirects (a guard that asks for a session), and what `skip`
// names (a page that is nothing but live data, like a search). The empty shell is kept as shell.html, for a host's
// fallback.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findChrome, launch, serve, openPage, shutDown, type Cdp } from './headless.js';
import { pruneCss } from './css-prune.js';
import { withCsp } from './dev-security.js';
import { parse } from '#engine/lang/parse.js';
import { KEY_ELEMENTS, READ_ATTRIBUTES, HIDE_MEASURED, UNKEY_COPY, UNMARK, markMeasured, asReading } from './prerender-vary.js';
import type { RouteFiles } from './route-preload.js';
import type { Route } from '#engine/shared/types.js';
import type { ConfigBlock } from '#engine/project/config.js';

export interface PrerenderOptions {
  root: string;
  outDir: string;
  routes: Route[];
  config: ConfigBlock;
  files: RouteFiles | null;
  sheets: { href: string; routes: { [page: string]: string } };
  policy: string | null;   // the CSP muten wrote into index.html, to write again with the loader's hash
  languages: string[];     // the app's languages (src/lang), when it speaks more than one
  say: (line: string) => void;
}
interface Drawn { html: string; text: number; title: string; lang: string; metas: Array<{ attr: string; key: string; content: string }>; styles: string[] }

const APP_EMPTY = '<div id="app"></div>';
// the copy is set in the page's real type: Google Fonts answer while it is drawn (muten's default CSP allows them too)
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const SETTLE_MS = 1000;
const LIMIT_MS = 15000;
const REDIRECT_MS = 1000;   // the app on another route this long: the page redirects
const STUCK_MS = 10000;
const RELAYOUT_MS = 2500;   // a page laid out on another screen settles within this
const SETTLE_RESIZE_MS = 600;   // …and never sooner: a script that measures may wait for the resize to end     // past its limit and this, a page that does not answer is given up
const STUCK: 'stuck' = 'stuck';
// hides what the app mounts beside the copy until the hand-over (laid out, so it measures right; never seen)
const HIDE_APP = '#app>[data-muten-snap]~*{position:absolute!important;top:0;left:0;width:100%;visibility:hidden;pointer-events:none}';
// the loader every written-out page carries, word for word: its list is the JSON beside it
export const BOOT_LOADER = "(()=>{const d=JSON.parse(document.getElementById('muten-boot').textContent);let a=!1;const go=()=>{if(a)return;a=!0;for(const h of d.files){const l=document.createElement('link');l.rel='modulepreload';l.href=h;document.head.appendChild(l)}const s=document.createElement('script');s.type='module';s.src=d.boot;document.body.appendChild(s)};if(document.documentElement.hasAttribute('data-muten-other-lang')){go();return}requestAnimationFrame(()=>requestAnimationFrame(go));setTimeout(go,2500)})()";

// the pictures a first screen shows, marked (runs in the page, once on a desktop screen and once on a phone's): only
// those keep their address in the copy
const MARK_SHOWN = `(() => {
  for (const img of document.querySelectorAll('#app img')) {
    const style = getComputedStyle(img);
    const seen = img.getClientRects().length && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
    if (seen && img.getBoundingClientRect().top + scrollY <= innerHeight) img.setAttribute('data-shown', '');
  }
  return true;
})()`;
// A page whose language the reader decides (no `lang from`: the app picks it from what they chose before, else their
// browser) is drawn in the app's default language. In <head>, before anything paints, this asks which language the
// app will speak to this reader; when it is another, the copy is hidden (and the app asked for at once): a reader never
// sees a page in a language that is not theirs. The same on every page (its data is the meta above it): one CSP hash.
export const LANG_GUARD = "(()=>{try{const m=document.querySelector('meta[name=\\\"muten-snap-lang\\\"]');if(!m)return;const d=JSON.parse(m.content);let s='';try{s=localStorage.getItem('muten:lang')||''}catch(e){}const b=(navigator.language||'').slice(0,2).toLowerCase();const w=[s,b].find(c=>d.langs.includes(c));if(w&&w!==d.drawn)document.documentElement.setAttribute('data-muten-other-lang','')}catch(e){}})()";
const HIDE_OTHER_LANG = '[data-muten-other-lang] #app>[data-muten-snap]{display:none}';

// what the page drew, made safe to sit in #app before the app runs (runs in the page)
const CAPTURE = `(() => {
  const app = document.getElementById('app');
  const copy = app.cloneNode(true);
  app.querySelectorAll('img[data-shown]').forEach((img) => img.removeAttribute('data-shown'));
  (${UNKEY_COPY})(copy);   // what a script laid out for one screen stays marked, hidden in the copy (prerender-vary.ts)
  // a picture no first screen shows loses its address (and waits); one that shows keeps how the page loads it
  copy.querySelectorAll('img').forEach((img) => {
    if (!img.hasAttribute('data-shown')) { img.removeAttribute('src'); img.removeAttribute('srcset'); img.setAttribute('loading', 'lazy'); }
    img.removeAttribute('data-shown');
  });

  copy.querySelectorAll('script, noscript, template, canvas, video, audio, iframe, object, embed').forEach((node) => node.remove());
  copy.querySelectorAll('*').forEach((node) => {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || attr.name === 'srcdoc') node.removeAttribute(attr.name);
  });
  // an icon drawn from a symbol the page keeps outside #app (a sprite a component adds to <body>) goes with the copy
  const used = new Set([...copy.querySelectorAll('use')].map((use) => (use.getAttribute('href') || use.getAttribute('xlink:href') || '').replace(/^#/, '')).filter(Boolean));
  const outside = [...used].filter((id) => !copy.querySelector('#' + CSS.escape(id))).map((id) => document.getElementById(id)).filter(Boolean);
  if (outside.length) {
    const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
    for (const symbol of outside) sprite.appendChild(symbol.cloneNode(true));
    copy.prepend(sprite);
  }
  const metas = [...document.head.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]')]
    .map((meta) => { const attr = meta.hasAttribute('property') ? 'property' : 'name'; return { attr, key: meta.getAttribute(attr), content: meta.getAttribute('content') || '' }; });
  // the styles the app put in <head> as it ran (each page's and part's own CSS, the skip link's): the copy needs them too
  const styles = [...document.head.querySelectorAll('style:not([data-muten-critical])')].map((style) => style.textContent || '');
  return { html: copy.innerHTML, text: (app.innerText || '').trim().length, title: document.title, lang: document.documentElement.lang || '', metas, styles };
})()`;
interface Screen { width: number; height: number; deviceScaleFactor: number; mobile: boolean; [key: string]: number | boolean }
const DESKTOP: Screen = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE: Screen = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

const escapeAttr = (text: string): string => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

/** Whether a page speaks the language its reader chose (no `lang from` of its own) in an app with several languages. */
function readerLanguage(o: PrerenderOptions, route: Route): boolean {
  if (o.languages.length < 2) return false;
  try { return !parse(readFileSync(join(o.root, 'src', 'pages', route.page, `${route.page}.muten`), 'utf8')).langFrom; } catch { return true; }
}

/** The language the copies are drawn in: the shell's <html lang> when the app has it, else the app's first. */
function defaultLanguage(shell: string, languages: string[]): string {
  const said = (/<html[^>]*\slang=["']([a-zA-Z]{2,3})/.exec(shell) || [])[1] || '';
  return languages.includes(said.toLowerCase()) ? said.toLowerCase() : languages[0] || said;
}

/** Which routes are written out, and why each other one is not. */
function chosen(o: PrerenderOptions): { routes: Route[]; left: string[] } {
  const skip = new Set(listOf(o.config.skip));
  const routes: Route[] = [];
  const left: string[] = [];
  for (const route of o.routes) {
    const url = '/' + route.url.replace(/^\//, '');
    // a guarded route is drawn as a first-time visitor sees it: its guard either lets them in (a login) or redirects
    const why = url.includes(':') ? 'a :param' : skip.has(url) ? 'skip' : '';
    if (why) left.push(`${url} (${why})`); else routes.push({ ...route, url });
  }
  return { routes, left };
}

/** The page's own HTML: the shell with the drawn copy, its head, its critical CSS and the deferred app. */
function writePage(shell: string, route: Route, drawn: Drawn, o: PrerenderOptions): string {
  let html = shell;
  if (drawn.lang) html = /<html[^>]*\slang=/i.test(html) ? html.replace(/(<html[^>]*\slang=)("[^"]*"|'[^']*')/i, `$1"${escapeAttr(drawn.lang)}"`) : html.replace(/<html/i, `<html lang="${escapeAttr(drawn.lang)}"`);
  if (drawn.title) html = /<title>[\s\S]*?<\/title>/i.test(html) ? html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeText(drawn.title)}</title>`) : html.replace('</head>', () => `  <title>${escapeText(drawn.title)}</title>\n</head>`);
  for (const meta of drawn.metas) {
    const tag = `<meta ${meta.attr}="${escapeAttr(meta.key)}" content="${escapeAttr(meta.content)}">`;
    const same = new RegExp(`<meta\\s+${meta.attr}=["']${meta.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*`, 'gi');
    html = html.replace(same, '').replace('</head>', () => `  ${tag}\n</head>`);
  }
  // the CSS this markup uses, inline; the whole sheet waits (media="print" until the app turns it on)
  const sheet = o.sheets.routes[route.page] || o.sheets.href;
  const css = sheet ? readFileSync(join(o.outDir, sheet), 'utf8') : '';
  // with the styles the app added to <head> while it ran (not the ones the shell already carries), pruned the same way
  const added = drawn.styles.filter((text) => text && !shell.includes(text)).join('\n');
  const critical = css || added ? pruneCss(`${css}\n${added}`, `${shell}\n${drawn.html}`).css : '';
  const guard = readerLanguage(o, route) ? `  <meta name="muten-snap-lang" content="${escapeAttr(JSON.stringify({ drawn: drawn.lang, langs: o.languages }))}">\n  <script>${LANG_GUARD}</script>\n` : '';
  html = html.replace('</head>', () => `${guard}  <style data-muten-critical>${HIDE_APP}${HIDE_OTHER_LANG}${HIDE_MEASURED}${critical}</style>\n</head>`);
  // the page paints with its inline CSS; what it defers is the WHOLE sheet when there is one (css-routes.ts): one
  // download that every later page also finds its rules in, instead of the common sheet and then this page's own
  const whole = o.sheets.routes['*'];
  if (o.sheets.href) html = html.replace(`<link rel="stylesheet" href="${o.sheets.href}">`, `<link rel="stylesheet" href="${whole || o.sheets.href}" media="print" data-muten-later>`);
  // the app after the first paint: no boot script nor preloads in the head, the loader and its list instead
  if (o.files) {
    const list = [...o.files.bootDeps, ...(o.files.pages[route.page] || [])];
    html = html.replace(/\s*<link rel="modulepreload" href="[^"]*">/g, '').replace(`<script type="module" src="${o.files.boot}"></script>`, '');
    html = html.replace('</body>', () => `  <script type="application/json" id="muten-boot">${JSON.stringify({ boot: o.files?.boot, files: list }).replace(/</g, '\\u003c')}</script>\n  <script>${BOOT_LOADER}</script>\n</body>`);
  }
  html = html.replace(APP_EMPTY, () => `<div id="app"><div data-muten-snap="${escapeAttr(route.url)}">${drawn.html}</div></div>`);
  if (o.policy) html = withCsp(html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/i, ''), o.policy);
  return html;
}

async function draw(cdp: Cdp, session: string, url: string, route: string, settle: number, screen: Screen): Promise<Drawn | 'redirects' | null> {
  const evaluate = async (expression: string): Promise<unknown> => {
    const answer = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    const result = answer.result?.result;
    return result && typeof result === 'object' && !Array.isArray(result) ? result.value : undefined;
  };
  await cdp.send('Page.navigate', { url }, session);
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  let elsewhereSince = 0;
  while (Date.now() - started < LIMIT_MS) {
    await new Promise((done) => setTimeout(done, 200));
    const at = await evaluate(`document.documentElement.getAttribute('data-muten-at')`);
    const length = await evaluate(`(document.getElementById('app')?.innerText || '').length`);
    // the app mounted another route and stays there: this one redirects (a page that asks for a session)
    if (typeof at === 'string' && at !== route) {
      elsewhereSince = elsewhereSince || Date.now();
      if (Date.now() - elsewhereSince >= REDIRECT_MS) return 'redirects';
      continue;
    }
    elsewhereSince = 0;
    if (at !== route) { stableSince = Date.now(); continue; }
    if (length !== last) { last = typeof length === 'number' ? length : -1; stableSince = Date.now(); }
    else if (last > 0 && Date.now() - stableSince >= settle) break;
  }
  // the pictures each first screen shows: on the screen it is drawn on, then on the other (laid out again), then back
  // laid out again, and settled: until the page's own scripts stop changing it (one that measures may wait for the
  // resize to end before it does), never longer than RELAYOUT_MS
  const relayout = async (to: Screen): Promise<void> => {
    await cdp.send('Emulation.setDeviceMetricsOverride', to, session);
    await evaluate("dispatchEvent(new Event('resize'))");   // what a browser does when its window changes size; emulation does not
    const started = Date.now();
    let before = '';
    while (Date.now() - started < RELAYOUT_MS) {
      await evaluate('new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 200))))');
      const now = JSON.stringify(await evaluate(READ_ATTRIBUTES));
      // two readings alike only count once a script has had the time a debounced resize takes to answer
      if (now === before && Date.now() - started >= SETTLE_RESIZE_MS) break;
      before = now;
    }
  };
  // …and which elements a script laid out differently on each: hidden in the copy (prerender-vary.ts)
  await evaluate(KEY_ELEMENTS);
  await evaluate(MARK_SHOWN);
  const onScreen = asReading(await evaluate(READ_ATTRIBUTES));
  await relayout(screen === PHONE ? DESKTOP : PHONE);
  await evaluate(MARK_SHOWN);
  const onOther = asReading(await evaluate(READ_ATTRIBUTES));
  await relayout(screen);
  await evaluate(markMeasured(onScreen, onOther));
  const drawn = await evaluate(CAPTURE);
  await evaluate(UNMARK);
  if (!drawn || typeof drawn !== 'object' || !('html' in drawn) || typeof drawn.html !== 'string') return null;
  const text = 'text' in drawn && typeof drawn.text === 'number' ? drawn.text : 0;
  const title = 'title' in drawn && typeof drawn.title === 'string' ? drawn.title : '';
  const lang = 'lang' in drawn && typeof drawn.lang === 'string' ? drawn.lang : '';
  const metas: Drawn['metas'] = [];
  if ('metas' in drawn && Array.isArray(drawn.metas)) {
    for (const meta of drawn.metas) {
      if (meta && typeof meta === 'object' && 'attr' in meta && 'key' in meta && 'content' in meta && typeof meta.attr === 'string' && typeof meta.key === 'string' && typeof meta.content === 'string') metas.push({ attr: meta.attr, key: meta.key, content: meta.content });
    }
  }
  const styles = 'styles' in drawn && Array.isArray(drawn.styles) ? drawn.styles.filter((text): text is string => typeof text === 'string') : [];
  return { html: drawn.html, text, title, lang, metas, styles };
}

/** Writes every page it can out as HTML. Returns how many it wrote (0 when there is no browser: said, not fatal). */
export async function prerender(o: PrerenderOptions): Promise<number> {
  const shell = readFileSync(join(o.outDir, 'index.html'), 'utf8');
  if (!shell.includes(APP_EMPTY)) { o.say(`  \x1b[33m!\x1b[0m prerender: index.html has no empty ${APP_EMPTY}; nothing written out`); return 0; }
  const chrome = findChrome();
  if (!chrome) { o.say('  \x1b[33m!\x1b[0m prerender: no Chrome or Chromium on this machine (CHROME_PATH points at one); the pages ship without their text'); return 0; }
  const { routes, left } = chosen(o);
  const allow = new Set([...FONT_HOSTS, ...listOf(o.config.allow)]);
  const settle = typeof o.config.wait === 'number' ? o.config.wait : SETTLE_MS;
  const work = mkdtempSync(join(tmpdir(), 'muten-prerender-'));
  const { server, base } = await serve(o.outDir, () => shell);   // every page drawn from the EMPTY shell
  const browser = await launch(chrome, join(work, 'profile'), defaultLanguage(shell, o.languages));
  const pages: Array<{ file: string; html: string }> = [];
  try {
    // the screen the copy is drawn on: what the app sets from its own measurements (a compact menu) is that screen's
    const screen = o.config.screen === 'phone' ? PHONE : DESKTOP;
    // a request to anywhere else is held, never answered: a page with live data is written out as it looks while its
    // data is on the way (its loading state), never with an error or a list from build time
    const fresh = async (): Promise<{ session: string; close: () => Promise<void> }> => {
      const page = await openPage(browser.cdp, (url) => url.startsWith(base) || allow.has(hostOf(url)), true);
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', screen, page.session);
      await browser.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, page.session);
      // every React island wakes while a page is drawn (runtime-island.ts): the copy holds what each one renders
      await browser.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__mutenWakeAll = true;' }, page.session);
      return page;
    };
    let page = await fresh();
    for (const route of routes) {
      // a page that never answers (a loop, a dialog) is left as the shell, and the next one gets a page of its own:
      // a build never hangs on one page
      const drawn = await within(draw(browser.cdp, page.session, base + route.url, route.url, settle, screen), LIMIT_MS + STUCK_MS, STUCK);
      if (drawn === STUCK) { left.push(`${route.url} (did not answer)`); await within(page.close(), STUCK_MS, undefined); page = await fresh(); continue; }
      if (drawn === 'redirects') { left.push(`${route.url} (redirects)`); continue; }
      if (!drawn || drawn.text === 0) { left.push(`${route.url} (drew no text)`); continue; }
      pages.push({ file: route.url === '/' ? 'index.html' : `${route.url.slice(1)}.html`, html: writePage(shell, route, drawn, o) });
    }
    await within(page.close(), STUCK_MS, undefined);
  } finally {
    await shutDown(browser.process);
    server.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  writeFileSync(join(o.outDir, 'shell.html'), shell);
  for (const page of pages) { mkdirSync(dirname(join(o.outDir, page.file)), { recursive: true }); writeFileSync(join(o.outDir, page.file), page.html); }
  o.say(`  prerender: ${pages.length} page${pages.length === 1 ? '' : 's'} written out${left.length ? ` · left as the shell: ${left.join(', ')}` : ''}`);
  return pages.length;
}

/** `work`, or `fallback` once `ms` have passed without it. */
function within<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<F>((done) => { timer = setTimeout(() => done(fallback), ms); })]).finally(() => clearTimeout(timer));
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}
