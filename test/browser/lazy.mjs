// `Custom X lazy` (headless Chrome; skipped when there is none), on a bundled page taller than the screen:
//   · a lazy Custom far below is not mounted, and what its mount imports is not downloaded, until it nears the screen;
//   · scrolled to, it mounts, and the module it imports arrives then;
//   · a Custom without `lazy` mounts with the page, as always.
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
const app = mkdtempSync(join(tmpdir(), 'muten-lazy-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('index.html', '<!doctype html>\n<html lang="es">\n<head>\n  <meta charset="utf-8">\n  <title>lazy</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/app.muten"></script>\n</body>\n</html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/pages/home/home.muten', 'screen home\nPage {\n  Custom Near class("near")\n  Stack class("spacer")\n  Custom Far lazy class("far")\n}\n');
write('src/components/Near.js', 'export function mount(el) { el.textContent = "near"; }\n');
write('src/components/Far.js', 'export function mount(el) { import("~/lib/heavy.ts").then((m) => { el.textContent = m.word(); }); }\n');
write('src/lib/heavy.ts', 'export function word(): string { return "far:" + "x".repeat(2000).length; }\n');
write('src/styles.css', '.spacer { height: 4000px; }\n');
const { bundleEsbuild } = await import(join(dist, 'esbuild-muten.js'));
const out = join(app, 'dist');
await bundleEsbuild(app, out, { quiet: true });
const heavyChunk = readdirSync(join(out, 'assets')).find((name) => name.startsWith('heavy-') && name.endsWith('.js'));
ok('what the lazy Custom imports is its own chunk', Boolean(heavyChunk), readdirSync(join(out, 'assets')).join(' '));

// ── a server that can lose a chunk ──
const served = [];
const server = createServer((req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);
  served.push(path);
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
  ok('the page shows, with the Custom that is not lazy mounted', await until(`document.querySelector('.near')?.textContent === 'near'`));
  await pause(800);
  ok('the lazy Custom far below is not mounted yet', (await evaluate(`document.querySelector('.far')?.textContent`)) === '');
  ok('…and what it imports was not downloaded', !served.some((path) => basename(path) === heavyChunk), served.join(' '));
  await evaluate(`scrollTo(0, document.body.scrollHeight)`);
  ok('scrolled to, it mounts with what it imports', await until(`(document.querySelector('.far')?.textContent || '').startsWith('far:')`), await evaluate(`document.querySelector('.far')?.textContent`));
  ok('…which arrived only then', served.some((path) => basename(path) === heavyChunk), served.join(' '));
} finally {
  ws.close(); browser.kill(); server.close();
  await pause(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
