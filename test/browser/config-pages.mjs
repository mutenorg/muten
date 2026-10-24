// muten.config blocks that change how the page behaves, in headless Chrome (skipped when there is none):
//   i18n { languages ["fr", "es", "en"]  default "fr"  detect false }
//     · a browser in English starts in French (the default; the browser's language does not count);
//     · a text Spanish lacks falls back to the default (French), not to whichever language sorts first;
//     · a draft .lang not listed does not ship, and check does not ask it for the keys it lacks;
//     · check says when a listed language has no file, or the default is not a language;
//   routes { preload "idle" }  · the other route's code loads with no pointer near its link (and not without it);
//   pwa { … offline true }     · the manifest carries the icons' own sizes; once the worker is in, the page opens offline.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-config-pages-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 58000 + Math.floor(Math.random() * 1500);
const config = (extra) => write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n${extra}`);
const I18N = 'i18n {\n  languages ["fr", "es", "en"]\n  default "fr"\n  detect false\n}\n';
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Config pages</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n  "/about" -> about\n}\n');
write('src/lang/fr.lang', 'home.hi "Bonjour"\nhome.only "Seulement fr"\nabout.t "À propos"\n');
write('src/lang/en.lang', 'home.hi "Hello"\nhome.only "Only en"\nabout.t "About"\n');
write('src/lang/es.lang', 'home.hi "Hola"\nabout.t "Acerca"\n');
write('src/lang/de.lang', 'home.hi "Hallo"\n');   // a draft: not listed
write('src/pages/home/home.muten', 'screen home\naction toSpanish() { lang.use("es") }\nPage {\n  Text "{t("home.hi")}" class("hi")\n  Text "{t("home.only")}" class("only")\n  Button "es" -> toSpanish class("es")\n  Link "about" -> "/about" class("go")\n}\n');
write('src/pages/about/about.muten', 'screen about\nPage {\n  Text "{t("about.t")}"\n}\n');
const check = () => { const run = spawnSync('node', [cli, 'check', '.', '--json'], { cwd: app, encoding: 'utf8' }); try { return JSON.parse(run.stdout); } catch { return [{ code: 'unparsed', message: run.stdout + run.stderr }]; } };

config(I18N);
const clean = check();
ok('a draft language not listed is not asked for its missing keys', !clean.some((one) => one.code === 'lang-missing' && /de\.lang|^de /.test(one.file + ' ' + one.message)), JSON.stringify(clean));
config('i18n {\n  languages ["fr", "pt"]\n  default "de"\n}\n');
const wrong = check();
ok('check: a listed language with no file', wrong.some((one) => /no src\/lang\/pt\.lang/.test(one.message)), JSON.stringify(wrong));
ok('check: a default that is not one of the languages', wrong.some((one) => /i18n\.default is "de"/.test(one.message)), JSON.stringify(wrong));

const profile = mkdtempSync(join(tmpdir(), 'muten-config-pages-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--lang=en-US', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 8000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };
const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const startDev = async () => { const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] }); await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); }); return dev; };
const aboutLoaded = () => evaluate(`performance.getEntriesByType('resource').some((entry) => /about/.test(entry.name))`);

let server = null;
try {
  config(I18N);
  let dev = await startDev();
  try {
    await send('Page.navigate', { url: `http://localhost:${port}/` });
    await until(`!!document.querySelector('.hi')`);
    ok('i18n detect false: a browser in English starts in the default, French', (await textOf('.hi')) === 'Bonjour', await textOf('.hi'));
    await evaluate(`document.querySelector('.es').click()`);
    await until(`document.querySelector('.hi')?.textContent === 'Hola'`, 3000);
    ok('…a text Spanish lacks falls back to the default (French), not the first by name', (await textOf('.only')) === 'Seulement fr', await textOf('.only'));
    await evaluate(`localStorage.clear()`);
    await pause(2500);
    ok('routes: without preload, the other route is not loaded until a pointer nears its link', !(await aboutLoaded()));
  } finally { dev.kill(); await pause(400); }

  config(I18N + 'routes {\n  preload "idle"\n}\n');
  dev = await startDev();
  try {
    await send('Page.navigate', { url: `http://localhost:${port}/` });
    await until(`!!document.querySelector('.hi')`);
    ok('routes { preload "idle" }: the other route loads with no pointer near it', await until(`performance.getEntriesByType('resource').some((entry) => /about/.test(entry.name))`, 6000));
  } finally { dev.kill(); await pause(400); }

  // pwa: bundle, serve dist, let the worker install, then open the page with no network
  const png = (size) => { const head = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(head, 0); head.writeUInt32BE(size, 16); head.writeUInt32BE(size, 20); return head; };
  mkdirSync(join(app, 'public'), { recursive: true });
  writeFileSync(join(app, 'public', 'icon-192.png'), png(192)); writeFileSync(join(app, 'public', 'icon-512.png'), png(512));
  config(I18N + 'pwa {\n  name "Config Pages"\n  color "#6B46F2"\n  icons ["public/icon-192.png", "public/icon-512.png"]\n  offline true\n}\n');
  const bundled = spawnSync('node', [cli, 'bundle', '.'], { cwd: app, encoding: 'utf8' });
  ok('muten bundle with pwa { } builds', bundled.status === 0, bundled.stdout + bundled.stderr);
  const manifest = JSON.parse(readFileSync(join(app, 'dist', 'manifest.webmanifest'), 'utf8'));
  ok('the manifest carries each icon at its own size, and the theme color', manifest.icons.map((icon) => icon.sizes).join(' ') === '192x192 512x512' && manifest.theme_color === '#6B46F2' && manifest.name === 'Config Pages', JSON.stringify(manifest));
  const html = readFileSync(join(app, 'dist', 'index.html'), 'utf8');
  ok('index.html links it and loads the worker\'s registration as a file (no inline script)', html.includes('rel="manifest"') && html.includes('src="/pwa.js"'), html.slice(0, 600));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  server = createServer((req, res) => {
    const path = join(app, 'dist', (req.url || '/').split('?')[0]);
    const file = existsSync(path) && extname(path) ? path : join(app, 'dist', 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const site = `http://127.0.0.1:${server.address().port}/`;
  await send('Network.enable');
  await send('Page.navigate', { url: site });
  await until(`!!document.querySelector('.hi')`);
  await evaluate('navigator.serviceWorker.ready.then(() => true)');   // installed and active (it claims the page: no reload)
  ok('the service worker installs and takes the page', await until('navigator.serviceWorker.controller !== null', 8000));
  await pause(800);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await send('Page.reload', { ignoreCache: false });
  ok('…and with no network, the page still opens', await until(`document.querySelector('.hi')?.textContent === 'Bonjour'`, 8000), await evaluate('document.body?.innerText?.slice(0, 200) ?? ""'));
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
} finally {
  ws.close(); browser.kill(); server?.close();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
