// When an island wakes (`wake load | idle | visible | media "(…)"`, runtime-island.ts), in headless Chrome; skipped when
// there is none. Each Custom notes when it mounts:
//   · `wake load` mounts as the page opens, `wake idle` soon after;
//   · `wake visible` (the default, here far below) waits until its place nears the screen;
//   · `wake media "(min-width: 2000px)"` never mounts at a narrower window, and does once the window is that wide;
//   · a wrong mode is a parse error that names the right ones, and `wake` on a Text is a finding.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-wake-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 54000 + Math.floor(Math.random() * 2000);
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>w</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n`);
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/styles.css', '.spacer { height: 4000px }\n');
for (const name of ['Now', 'Later', 'Below', 'Wide']) write(`src/components/${name}.js`, `function mount(el) { (window.__woke = window.__woke || []).push(${JSON.stringify(name)}); el.textContent = ${JSON.stringify(name)}; }\n`);
const page = (extra = '') => write('src/pages/home/home.muten', `screen home
Page {
  Custom Now wake load
  Custom Later wake idle
  Custom Wide wake media "(min-width: 2000px)"
  Stack class("spacer") { Text "…" }
  Custom Below wake visible
  ${extra}
}
`);
page();

const check = (body) => { write('src/pages/home/home.muten', body); return spawnSync('node', [cli, 'check', '.'], { cwd: app, encoding: 'utf8' }); };
const wrongMode = check('screen home\nPage {\n  Custom Now wake idel\n}\n');
ok('a wrong mode is a parse error that names the right one', /did you mean `idle`/.test(wrongMode.stdout + wrongMode.stderr), wrongMode.stdout + wrongMode.stderr);
const onText = check('screen home\nPage {\n  Text "x" wake idle\n}\n');
ok('wake on a Text is a finding', /wake-target/.test(onText.stdout + onText.stderr), onText.stdout + onText.stderr);
page();

const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
const profile = mkdtempSync(join(tmpdir(), 'muten-wake-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--window-size=1200,800', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 6000) => { for (let waited = 0; waited < ms; waited += 50) { if (await evaluate(expression)) return true; await pause(50); } return false; };
const woke = () => evaluate('JSON.stringify(window.__woke || [])');

try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  ok('wake load mounts as the page opens', await until(`(window.__woke || [])[0] === 'Now'`), await woke());
  ok('wake idle mounts soon after', await until(`(window.__woke || []).includes('Later')`, 3000), await woke());
  await pause(500);
  ok('wake visible, far below, has not mounted', !(await evaluate(`(window.__woke || []).includes('Below')`)), await woke());
  ok('wake media "(min-width: 2000px)" has not mounted at 1200 px', !(await evaluate(`(window.__woke || []).includes('Wide')`)), await woke());
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  ok('…the one below mounts once its place nears the screen', await until(`(window.__woke || []).includes('Below')`, 3000), await woke());
  await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 800, deviceScaleFactor: 1, mobile: false });
  ok('…and the media one once the window is that wide', await until(`(window.__woke || []).includes('Wide')`, 3000), await woke());
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
