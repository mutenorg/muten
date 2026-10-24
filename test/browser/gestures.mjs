// Touch gestures on any element (runtime-gesture.ts), driven with real touch input over CDP (Input.dispatchTouchEvent,
// what a phone sends), in headless Chrome; skipped when there is none.
//   · a flick left / up runs swipe-left / swipe-up; a diagonal runs neither; a slow short drag is not a swipe;
//   · holding still runs long-press (and the click it ends with does not also fire);
//   · two taps close together run double-tap;
//   · two fingers spreading run pinch with the scale;
//   · the element keeps vertical scrolling for the page when it only swipes sideways (touch-action).
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

const app = mkdtempSync(join(tmpdir(), 'muten-gestures-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 50000 + Math.floor(Math.random() * 2000);
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>g</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n`);
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/styles.css', '.pad { width: 300px; height: 300px; background: #ddd } .side { width: 300px; height: 120px; background: #bbd }\n');
write('src/pages/home/home.muten', `screen home
state { said = "" : text  scale = 1 : number  clicks = 0 : number }
action left mutates said { said.set("left") }
action up mutates said { said.set("up") }
action press mutates said { said.set("press") }
action twice mutates said { said.set("twice") }
action zoom(s: number) mutates scale { scale.set(s) }
action clicked mutates clicks { clicks.set(clicks + 1) }
action next mutates said { said.set("next") }
Page {
  Stack class("pad") on(swipe-left: left, swipe-up: up, long-press: press, double-tap: twice, pinch: zoom, click: clicked) {
    Text "pad"
  }
  Stack class("side") on(swipe-left: next) {
    Text "side"
  }
  Span "{said}" class("said")
  Span "{scale}" class("scale")
  Span "{clicks}" class("clicks")
}
`);

const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
const profile = mkdtempSync(join(tmpdir(), 'muten-gestures-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 8000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };
const said = () => evaluate(`document.querySelector('.said').textContent`);
const box = async (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const touch = (type, points) => send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], index) => ({ x, y, id: index })) });
// one finger from → to over `ms`, in steps
const drag = async (from, to, ms, steps = 6) => {
  await touch('touchStart', [from]);
  for (let step = 1; step <= steps; step++) { await pause(ms / steps); await touch('touchMove', [[from[0] + (to[0] - from[0]) * step / steps, from[1] + (to[1] - from[1]) * step / steps]]); }
  await touch('touchEnd', []);
  await pause(80);
};

try {
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await until(`!!document.querySelector('.pad')`);
  await pause(300);
  const pad = await box('.pad');
  await drag([pad.x + 80, pad.y], [pad.x - 80, pad.y], 120);
  ok('a flick to the left runs swipe-left', (await said()) === 'left', await said());
  await drag([pad.x, pad.y + 80], [pad.x, pad.y - 80], 120);
  ok('a flick up runs swipe-up', (await said()) === 'up', await said());
  await evaluate(`document.querySelector('.said').textContent = ''`);
  await drag([pad.x - 60, pad.y + 60], [pad.x + 0, pad.y + 0], 120);
  ok('a diagonal runs no swipe', (await said()) === '', await said());
  await drag([pad.x + 10, pad.y], [pad.x - 20, pad.y], 900, 12);
  ok('a slow, short drag is not a swipe', (await said()) === '', await said());

  const clicksBefore = await evaluate(`document.querySelector('.clicks').textContent`);
  await touch('touchStart', [[pad.x, pad.y]]); await pause(650); await touch('touchEnd', []); await pause(150);
  ok('holding still runs long-press', (await said()) === 'press', await said());
  ok('…and the click it ends with does not also fire', (await evaluate(`document.querySelector('.clicks').textContent`)) === clicksBefore, await evaluate(`document.querySelector('.clicks').textContent`));

  await pause(400);
  for (let tap = 0; tap < 2; tap++) { await touch('touchStart', [[pad.x, pad.y]]); await pause(40); await touch('touchEnd', []); await pause(90); }
  ok('two quick taps run double-tap', (await said()) === 'twice', await said());

  await touch('touchStart', [[pad.x - 30, pad.y], [pad.x + 30, pad.y]]);
  for (let step = 1; step <= 6; step++) { await pause(30); await touch('touchMove', [[pad.x - 30 - step * 5, pad.y], [pad.x + 30 + step * 5, pad.y]]); }
  await touch('touchEnd', []); await pause(150);
  const scale = Number(await evaluate(`document.querySelector('.scale').textContent`));
  ok('two fingers spreading run pinch with the scale (60 px → 120 px apart: 2)', Math.abs(scale - 2) < 0.15, String(scale));

  const actions = await evaluate(`[getComputedStyle(document.querySelector('.pad')).touchAction, getComputedStyle(document.querySelector('.side')).touchAction].join(' | ')`);
  ok('touch-action: the pad takes everything; the sideways-only one leaves vertical scroll to the page', actions === 'none | pan-y pinch-zoom', actions);
  const side = await box('.side');
  await drag([side.x + 80, side.y], [side.x - 80, side.y], 120);
  ok('a second element with its own gesture runs its own action', (await said()) === 'next', await said());
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
