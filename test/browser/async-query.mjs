// A search with no bridge: an async `fn` in the page, read as `query search(find)`, behind `settle` (headless Chrome;
// skipped when there is none). What a hand-written search Custom used to do, the page now says in three lines:
//   · typing waits for the pause (settle), then asks once;
//   · while it asks, `hits.loading` is true;
//   · an answer that comes back late, for what the person typed before, is dropped: the latest question wins.
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

const app = mkdtempSync(join(tmpdir(), 'muten-async-query-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 52000 + Math.floor(Math.random() * 2000);
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>q</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n`);
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/pages/home/home.muten', `screen home
fn search(q: string): Promise<string[]> {
  window.__asked = (window.__asked || []).concat([q])
  const wait = q === "a" ? 700 : 60
  return new Promise((done) => setTimeout(() => done(q ? [q + "-1", q + "-2"] : []), wait))
}
state { typed = "" : text  find = "" : text  hits = query search(find) : list<text> }
settle typed 200ms { find.set(typed) }
Page {
  SearchField bind(typed) class("q") aria(label: "Search")
  when hits.loading { Text "…" class("loading") }
  each hits as h { Text "{h}" class("hit") }
}
`);

const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
const profile = mkdtempSync(join(tmpdir(), 'muten-async-query-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 8000) => { for (let waited = 0; waited < ms; waited += 50) { if (await evaluate(expression)) return true; await pause(50); } return false; };
const type = (text) => evaluate(`(() => { const box = document.querySelector('.q'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const hits = () => evaluate(`[...document.querySelectorAll('.hit')].map((h) => h.textContent).join(',')`);

try {
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await until(`!!document.querySelector('.q')`);
  await until(`window.__asked && window.__asked.length === 1`);   // the empty question the page opens with
  await type('a'); await pause(60); await type('a');
  ok('typing waits for the pause: nothing asked yet', (await evaluate('window.__asked.length')) === 1, await evaluate('JSON.stringify(window.__asked)'));
  await until(`window.__asked.length === 2`, 1000);
  ok('…then asks once', (await evaluate('JSON.stringify(window.__asked)')) === '["","a"]', await evaluate('JSON.stringify(window.__asked)'));
  ok('while it asks, hits.loading is true', await until(`!!document.querySelector('.loading')`, 300));
  await type('ab');
  await until(`document.querySelectorAll('.hit').length === 2`, 1500);
  ok('the later question answers first', (await hits()) === 'ab-1,ab-2', await hits());
  await pause(900);   // the slow answer for "a" arrives now
  ok('the late answer for what was typed before is dropped: the latest question wins', (await hits()) === 'ab-1,ab-2', await hits());
  ok('…and loading is over', !(await evaluate(`!!document.querySelector('.loading')`)));
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
