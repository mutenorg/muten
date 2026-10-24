// The router against a real browser (headless Chrome; skipped when there is none), on a bundled two-page app:
//   · the boot's own chunks are preloaded from index.html and each page's files are listed for the router;
//   · a pointer resting on a link asks for that page's code and stylesheet before the click;
//   · a ctrl+click is the browser's (a new tab), not an in-app navigation; a plain click navigates without a reload;
//   · a page whose chunk is gone (a deploy replaced it) makes the browser load the address itself, once, instead of
//     leaving the old page on screen under the new address.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';

const dist = new URL('../../dist/', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

// ── the app ──
const app = mkdtempSync(join(tmpdir(), 'muten-nav-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('index.html', '<!doctype html>\n<html lang="es">\n<head>\n  <meta charset="utf-8">\n  <title>nav</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/app.muten"></script>\n</body>\n</html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n  "/about" -> about\n}\n');
write('src/pages/home/home.muten', 'screen home\nPage {\n  Title "Inicio"\n  Link "Acerca" -> "/about" class("to-about")\n}\n');
write('src/pages/about/about.muten', 'screen about\nstate { n = 0 : number }\naction up mutates n { n.set(n + 1) }\nPage {\n  Title "Acerca de nosotros" class("about-title")\n  Button "{n}" -> up\n}\n');
write('src/styles.css', '.to-about { color: rgb(1, 2, 3); }\n.about-title { color: rgb(4, 5, 6); }\n');
const { bundleEsbuild } = await import(join(dist, 'esbuild-muten.js'));
const out = join(app, 'dist');
await bundleEsbuild(app, out, { quiet: true });
const index = readFileSync(join(out, 'index.html'), 'utf8');
const aboutChunk = readdirSync(join(out, 'assets')).find((name) => name.startsWith('about-') && name.endsWith('.js'));
ok('index.html lists each page\'s files for the router', index.includes('name="muten-route-js"'), index.slice(0, 600));

// ── a server that can lose a chunk ──
let missing = '';
const served = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  served.push(path);
  if (missing && basename(path) === missing) { res.writeHead(404); return res.end(); }
  let file = join(out, path);
  if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) file = join(out, 'index.html');
  res.writeHead(200, { 'content-type': { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0, '127.0.0.1');
await new Promise((done) => server.on('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'muten-nav-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; let loads = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Page.loadEventFired') loads++; waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (expression, ms = 5000) => { for (let waited = 0; waited < ms; waited += 50) { if (await evaluate(expression)) return true; await pause(50); } return false; };
const mouse = (type, at, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1, modifiers });
const linkAt = () => evaluate(`(() => { const r = document.querySelector('.to-about').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await send('Page.enable');

try {
  await send('Page.navigate', { url: base + '/' });
  ok('the home page shows', await until(`!!document.querySelector('.to-about')`));
  const preloads = await evaluate(`[...document.querySelectorAll('link[rel=modulepreload]')].length`);
  ok('the boot\'s own chunks are preloaded from index.html', preloads > 0, String(preloads));

  served.length = 0;
  await until(`[...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /\\/assets\\/all-/.test(l.getAttribute('href')) && l.sheet)`, 5000);   // the whole sheet, asked for once the first page is up
  served.length = 0;
  const at = await linkAt();
  await mouse('mouseMoved', at);
  await pause(400);
  ok('resting on a link asks for its page before the click', served.some((path) => basename(path) === aboutChunk), served.join(' '));
  ok('…not its own stylesheet: the whole sheet came in after the first page, every page finds its rules there', !served.some((path) => /about\.route-.*\.css$/.test(path)) && (await evaluate(`[...document.querySelectorAll('link[rel=stylesheet]')].some((l) => /\\/assets\\/all-/.test(l.getAttribute('href')))`)) === true, served.join(' '));

  await mouse('mousePressed', at, 2); await mouse('mouseReleased', at, 2);   // 2 = ctrl
  await pause(400);
  ok('a ctrl+click is the browser\'s: the app stays where it is', (await evaluate('location.pathname')) === '/');

  const before = loads;
  await mouse('mousePressed', at); await mouse('mouseReleased', at);
  ok('a plain click opens the page in the app', await until(`!!document.querySelector('.about-title')`));
  ok('…without loading the document again', loads === before, `${loads - before} loads`);

  // a deploy replaced the chunks: the old tab asks for a name that is gone
  missing = aboutChunk;
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: base + '/' });
  await until(`!!document.querySelector('.to-about')`);
  await pause(300);
  const reloadsBefore = loads;
  const at2 = await linkAt();
  await mouse('mousePressed', at2); await mouse('mouseReleased', at2);
  await pause(2500);
  ok('a page whose chunk is gone makes the browser load its address', loads > reloadsBefore && (await evaluate('location.pathname')) === '/about', `${loads - reloadsBefore} loads at ${await evaluate('location.pathname')}`);
  const after = loads;
  await pause(1500);
  ok('…once: a page that is really missing does not reload forever', loads === after, `${loads - after} more loads`);
} finally {
  ws.close(); browser.kill(); server.close();
  await pause(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
