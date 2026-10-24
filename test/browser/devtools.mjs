// The devtools `muten dev` shows by itself (headless Chrome; skipped when there is none), on a small app that has what
// they must catch: a request answered with a web page instead of data, a text one language lacks, a counter that
// redraws (and, picked, what it reads), and a finding of `check`. And `dev { devtools false }` takes them away.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-devtools-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 46000 + Math.floor(Math.random() * 2000);
write('index.html', '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>dt</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('muten.config', `dev {\n  port ${port}\n}\n`);
write('src/lang/es.lang', 'home.add "Agregar"\nhome.empty "Nada aún"\n');
write('src/lang/en.lang', 'home.add "Add"\n');
write('src/pages/home/home.muten', 'screen home\nentity Item { name text }\nstate { n = 0 : number  items = query items : list<Item>  idle = 0 : number }\nsources { items: "/api/items" }\naction add mutates n { n.set(n + 1) }\nPage {\n  Text "{t("home.empty")} {items.length}"\n  Button "{t("home.add")}" -> add class("add")\n  Span "{n}" class("count")\n}\n');

const startDev = async () => {
  const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
  return dev;
};

const profile = mkdtempSync(join(tmpdir(), 'muten-devtools-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--lang=en', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 8000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };
const panel = (selector) => `document.getElementById('muten-devtools-host')?.shadowRoot?.querySelector(${JSON.stringify(selector)})`;
const tab = (name) => evaluate(`[...(document.getElementById('muten-devtools-host')?.shadowRoot?.querySelectorAll('.tab') || [])].find((t) => t.textContent.startsWith(${JSON.stringify(name)}))?.click()`);
const text = () => evaluate(`document.getElementById('muten-devtools-host')?.shadowRoot?.querySelector('.panel')?.innerText || ''`);

let dev = await startDev();
try {
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  ok('muten dev shows the devtools with nothing installed or configured', await until(`!!${panel('.panel')}`));
  for (let i = 0; i < 3; i++) { await evaluate(`document.querySelector('.add').click()`); await pause(120); }
  await tab('Data'); await pause(700);
  ok('Data: a request answered with a web page instead of data is called out', /answered with a web page/.test(await text()), await text());
  await tab('Timeline'); await pause(700);
  ok('Timeline: the click and the action it fired are one moment, with what changed', /you clicked «Add» → action add/.test(await text()) && /n 2 → 3/.test(await text()), await text());
  await tab('Texts'); await pause(1200);
  ok('Texts: a text the language on screen lacks is said', /home\.empty/.test(await text()) && /another language|bare key/.test(await text()), await text());
  await tab('Issues'); await pause(2500);
  ok('Issues: check\'s finding on this page is there', /unused-state/i.test(await text()), await text());
  await tab('Inspect'); await pause(300);
  await evaluate(`[...document.getElementById('muten-devtools-host').shadowRoot.querySelectorAll('button')].find((b) => b.textContent === 'Pick')?.click()`);
  await pause(200);
  await evaluate(`(() => { const el = document.querySelector('.count'); const r = el.getBoundingClientRect(); for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: r.left + 2, clientY: r.top + 2 })); })()`);
  await pause(500);
  ok('Inspect: a picked element says what it reads, with its value now', /It reads/i.test(await text()) && /n = 3/.test(await text()), await text());
  const redrawn = await evaluate(`(() => { const all = window.__muten_page?.nodes || {}; const el = document.querySelector('.count'); return Object.entries(all).some(([id, rec]) => rec.el === el); })()`);
  ok('the runtime knows the node each redraw drew', redrawn === true);
} finally {
  dev.kill(); await pause(300);
}
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n`);
dev = await startDev();
try {
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await until(`!!document.querySelector('.add')`);
  await pause(800);
  ok('dev { devtools false } takes them away', (await evaluate(`!!document.getElementById('muten-devtools-host')`)) === false);
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
