// A static page with data that changes (what Astro calls a server island): `muten build` writes the page with the data
// the build saw, and the page asks again when it runs, so a price or a stock count is fresh without a server rendering
// each request. The test builds against a server answering 10, then makes it answer 20 (headless Chrome; skipped when
// there is none):
//   · the written-out HTML holds 10 (what a crawler or a reader without JavaScript gets, with no placeholder);
//   · the page, once its script runs, shows 20.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-fresh-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
let price = 10;
const server = createServer((req, res) => {
  if (req.url === '/items') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify([{ id: 1, name: 'A', price }])); return; }
  try { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync(join(app, 'dist', 'index.html'))); } catch { res.writeHead(404); res.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>f</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/pages/home/home.muten', `screen home
entity Item { name text  price number }
state { items = query items : list<Item> }
sources { items: "http://127.0.0.1:${port}/items" }
Page {
  each items as it { Text "{it.name} {it.price}" class("row") }
}
`);

const profile = mkdtempSync(join(tmpdir(), 'muten-fresh-chrome-'));
let browser = null;
try {
  // not spawnSync: the build asks this test's own server for the data, which must stay free to answer
  const built = await new Promise((done) => { const run = spawn('node', [cli, 'build', '.'], { cwd: app }); let said = ''; run.stdout.on('data', (d) => { said += d; }); run.stderr.on('data', (d) => { said += d; }); run.on('close', (code) => done({ code, said })); });
  ok('muten build writes the page', built.code === 0, built.said);
  const html = readFileSync(join(app, 'dist', 'index.html'), 'utf8');
  ok('the written-out page holds the data the build saw (10), no placeholder', html.includes('>A 10<'), (html.match(/row">[^<]*</) || ['none'])[0]);
  price = 20;
  browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
  let id = 0; const waiting = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
  const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  let shown = '';
  for (let waited = 0; waited < 6000 && shown !== 'A 20'; waited += 100) { shown = await evaluate(`document.querySelector('.row')?.textContent ?? ''`); await pause(100); }
  ok('once its script runs, the page shows what the server says now (20)', shown === 'A 20', shown);
  ws.close();
} finally {
  browser?.kill();
  server.close();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
