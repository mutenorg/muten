// `prerender { }` (src/prerender.ts + runtime-snap.ts) against a real browser (headless Chrome; skipped when there is
// none), on a bundled app with a Content-Security-Policy:
//   · each page is written out with what the app drew, its head (title, description, lang), its critical CSS and the
//     loader that asks for the app after the first paint; a :param route is left as the shell, which is kept;
//   · with JavaScript off, the page is there, styled;
//   · with it on, the app takes over the copy: one page on screen, no layout shift, no CSP violation;
//   · a page with live data is written out loading, and the build never answers a request to an API.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const dist = new URL('../../dist/', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }
process.env.CHROME_PATH = chrome;

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

// ── the app ──
const app = mkdtempSync(join(tmpdir(), 'muten-prerender-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('index.html', '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>shell</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/app.muten"></script>\n</body>\n</html>\n');
write('muten.config', 'security {\n  csp "default"\n}\nprerender {\n  skip ["/hidden"]\n}\n');
write('src/app.muten', 'routes {\n  "/" -> home\n  "/about" -> about\n  "/hidden" -> hidden\n  "/item/:id" -> item\n  "/news" -> news\n}\n');
write('src/pages/home/home.muten', 'screen home\nmeta {\n  title "Casa Lino"\n  description "Un spa en Cabimas"\n  lang "es"\n}\nstate { n = 0 : number }\naction up mutates n { n.set(n + 1) }\nPage class("home") {\n  Title "Bienvenida a Casa Lino" class("hero")\n  Text "Masajes y faciales" class("lead")\n  Link "Acerca" -> "/about" class("to-about")\n  Button "Visitas {n}" -> up class("count")\n}\n');
write('src/pages/about/about.muten', 'screen about\nPage {\n  Title "Acerca de nosotros" class("about-title")\n  Custom Measure class("measured-bar")\n  Text "fijo" class("steady")\n}\n');
write('src/pages/hidden/hidden.muten', 'screen hidden\nPage { Text "oculta" }\n');
write('src/pages/item/item.muten', 'screen item\nparam id\nPage { Text "item {id}" }\n');
write('src/pages/news/news.muten', 'screen news\nentity Post { title text }\nstate { posts = query posts : list<Post> }\nsources { posts: "https://api.example.invalid/posts" }\nPage {\n  Title "Noticias" class("news-title")\n  when posts.loading { Text "Cargando noticias" class("news-loading") }\n  each posts as p { Text "{p.title}" }\n}\n');
// a component that lays itself out by measuring the screen (Storio's bar does): its result is one screen's only
write('src/components/Measure.js', 'export function mount(el) {\n  const set = () => el.setAttribute("data-w", innerWidth > 800 ? "wide" : "narrow");\n  set();\n  addEventListener("resize", set);\n}\n');
write('src/styles.css', '.hero { color: rgb(10, 20, 30); font-size: 40px; }\n.lead { color: rgb(1, 2, 3); }\n.never-used-anywhere { color: red; }\n.about-title { color: rgb(4, 5, 6); }\n');
const { bundleEsbuild } = await import(join(dist, 'esbuild-muten.js'));
const out = join(app, 'dist');
await bundleEsbuild(app, out, { quiet: true });
const page = (file) => (existsSync(join(out, file)) ? readFileSync(join(out, file), 'utf8') : '');
const home = page('index.html');

ok('the home is written out with what the app drew', home.includes('data-muten-snap="/"') && home.includes('Bienvenida a Casa Lino'));
ok('…with its own head: title, description, lang', home.includes('<title>Casa Lino</title>') && home.includes('content="Un spa en Cabimas"') && /<html lang="es"/.test(home), home.slice(0, 500));
ok('…its critical CSS inline, without the rules its markup never uses', /<style data-muten-critical>[^<]*\.hero/.test(home) && !/<style data-muten-critical>[^<]*never-used-anywhere/.test(home));
ok('…the stylesheet no longer blocks the first paint', /<link rel="stylesheet" href="[^"]+" media="print" data-muten-later>/.test(home));
ok('…and the app asked for after the paint, by a loader the CSP allows by hash', home.includes('id="muten-boot"') && !/<script type="module" src="\/assets\/boot-/.test(home) && /script-src[^;"]*'sha256-/.test(home));
ok('another page has its own file', page('about.html').includes('Acerca de nosotros') && page('about.html').includes('data-muten-snap="/about"'));
ok('what a script laid out for one screen is in the copy but not shown', /class="[^"]*measured-bar[^"]*"[^>]*data-muten-measured/.test(page('about.html')) && page('about.html').includes('[data-muten-measured]{opacity:0') && !/class="[^"]*steady[^"]*"[^>]*data-muten-measured/.test(page('about.html')), (page('about.html').match(/<[^>]*measured-bar[^>]*>/) || [''])[0]);
ok('a :param route and a skipped one are left as the shell, which is kept', !existsSync(join(out, 'item.html')) && !existsSync(join(out, 'hidden.html')) && page('shell.html').includes('<div id="app"></div>'));
ok('a page with live data is written out loading, never with an error', page('news.html').includes('Cargando noticias'), page('news.html').slice(-800));

// ── a static host: /x is x.html, else the shell ──
let out2 = '';   // the second app's build, served on its own port (its own origin, so its own localStorage)
const host = (root) => (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  let file = join(root(), path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = path === '/' ? join(root(), 'index.html') : existsSync(join(root(), path + '.html')) ? join(root(), path + '.html') : join(root(), 'shell.html');
  res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
};
const server = createServer(host(() => out)).listen(0, '127.0.0.1');
const server2 = createServer(host(() => out2)).listen(0, '127.0.0.1');
await new Promise((done) => server.on('listening', done));
await new Promise((done) => (server2.listening ? done() : server2.on('listening', done)));
const base = `http://127.0.0.1:${server.address().port}`;
const base2 = () => `http://127.0.0.1:${server2.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'muten-prerender-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map(); const problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Log.entryAdded' && /Content Security Policy|Refused to/.test(m.params.entry.text)) problems.push(m.params.entry.text);
  waiting.get(m.id)?.(m);
});
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (expression, ms = 6000) => { for (let waited = 0; waited < ms; waited += 50) { if (await evaluate(expression)) return true; await pause(50); } return false; };
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

try {
  // JavaScript off: what a crawler that runs none, or the first paint, shows
  await send('Emulation.setScriptExecutionDisabled', { value: true });
  await send('Page.navigate', { url: base + '/' });
  await pause(800);
  ok('with JavaScript off the page is there, styled by its inline CSS', (await evaluate(`document.body.innerText.includes('Bienvenida a Casa Lino')`)) !== false
    && (await (async () => { await send('Emulation.setScriptExecutionDisabled', { value: false }); return evaluate(`getComputedStyle(document.querySelector('.hero')).color`); })()) === 'rgb(10, 20, 30)');

  // JavaScript on: the app takes over
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__cls = 0; window.__shifts = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(e.sources.map((s) => (s.node && s.node.outerHTML || '?').slice(0, 120) + ' ' + JSON.stringify(s.previousRect) + '→' + JSON.stringify(s.currentRect)).join(' ; ')); } }).observe({ type: 'layout-shift', buffered: true });" });
  await send('Page.navigate', { url: base + '/' });
  ok('the app takes over: its page is mounted and the copy is gone', await until(`document.documentElement.getAttribute('data-muten-at') === '/' && !document.querySelector('[data-muten-snap]')`), await evaluate('document.body.innerHTML.slice(0, 300)'));
  ok('…one page on screen, not two', (await evaluate(`document.querySelectorAll('.hero').length`)) === 1);
  ok('…without moving anything', (await evaluate('window.__cls')) === 0, String(await evaluate('window.__cls')) + ' ' + JSON.stringify(await evaluate('window.__shifts')));
  ok('…and the app works', await (async () => { await evaluate(`document.querySelector('.count').click()`); return until(`document.querySelector('.count').textContent.includes('1')`); })());
  ok('…and the deferred stylesheet is on', (await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].every((l) => l.media !== 'print')`)) === true);
  ok('…the copy\'s inline CSS left with the copy (one page\'s rules must not win over the next page\'s)', (await evaluate(`!document.querySelector('style[data-muten-critical]')`)) === true);
  ok('…and what it deferred is the whole sheet, so moving to another page downloads no CSS', (await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /\\/assets\\/all-/.test(l.getAttribute('href')))`)) === true, await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')).join(' ')`));
  ok('no error, no Content-Security-Policy refusal', problems.length === 0, problems.join(' | '));

  // ── a page whose language the reader decides: drawn in the app's default, never shown to a reader of another ──
  const two = mkdtempSync(join(tmpdir(), 'muten-prerender-lang-'));
  const put = (path, text) => { mkdirSync(join(two, path, '..'), { recursive: true }); writeFileSync(join(two, path), text); };
  put('index.html', '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>two</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/app.muten"></script>\n</body>\n</html>\n');
  put('muten.config', 'security {\n  csp "default"\n}\nprerender {\n}\n');
  put('src/app.muten', 'routes {\n  "/" -> home\n}\n');
  put('src/lang/en.lang', 'hello "Hello there"\n');
  put('src/lang/es.lang', 'hello "Hola, bienvenida"\n');
  put('src/pages/home/home.muten', 'screen home\nPage {\n  Title "{t("hello")}" class("greet")\n}\n');
  await bundleEsbuild(two, join(two, 'dist'), { quiet: true });
  const drawnHtml = readFileSync(join(two, 'dist', 'index.html'), 'utf8');
  ok('drawn in the app\'s default language, whatever this machine speaks', drawnHtml.includes('Hello there') && drawnHtml.includes('name="muten-snap-lang"'), drawnHtml.slice(-1500));
  out2 = join(two, 'dist');
  await send('Page.navigate', { url: base2() + '/' });
  await until(`document.readyState === 'complete'`);
  await evaluate(`localStorage.setItem('muten:lang', 'es')`);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "document.addEventListener('DOMContentLoaded', () => { const copy = document.querySelector('[data-muten-snap]'); window.__copyShown = !!copy && getComputedStyle(copy).display !== 'none'; });" });
  await send('Page.navigate', { url: base2() + '/' });
  ok('a reader who chose another language never sees the copy', await until(`window.__copyShown === false`, 3000), String(await evaluate('window.__copyShown')));
  ok('…and gets the app in their language', await until(`document.querySelector('.greet')?.textContent === 'Hola, bienvenida' && !document.querySelector('[data-muten-snap]')`), await evaluate(`document.body.innerText.slice(0, 200)`));
  await evaluate(`localStorage.setItem('muten:lang', 'en')`);
  await send('Page.navigate', { url: base2() + '/' });
  ok('a reader of the default language gets the copy', await until(`window.__copyShown === true`, 3000));
  rmSync(two, { recursive: true, force: true });
} finally {
  ws.close(); browser.kill(); server.close(); server2.close();
  await pause(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
