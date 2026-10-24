// What `muten dev` does when the app is broken (headless Chrome; skipped when there is none):
//   · started on a page with a syntax error, the server stays up, shows the error at its line, and the page works as
//     soon as the file is fixed (no restart);
//   · an error thrown in the browser is shown at the app's own line (dev-errors.ts) with what it means (runtime-hints.ts);
//   · `muten report` writes the versions, check, and that last error, and none of muten.config's values (report.ts).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-dev-errors-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
const port = 56000 + Math.floor(Math.random() * 2000);
write('package.json', '{"name":"de","private":true}\n');
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>d</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\nenv {\n  prod {\n    api "https://secret-host.example"\n  }\n}\n`);
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/lib/boom.ts', 'export function boom(n: number): number {\n  const box = n > 0 ? undefined : { a: 1 };\n  return box.a;\n}\n');
const good = 'screen home\nuse boom from "~/lib/boom.ts"\nstate { n = 0 : number }\naction go mutates n { n.set(n + 1) }\nPage {\n  Button "go" -> go class("go")\n  Text "{boom(n)}" class("out")\n}\n';
write('src/pages/home/home.muten', good.replace('Page {', 'Page {{'));   // a syntax error, from the start

const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
let exited = false; dev.on('exit', () => { exited = true; });
await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
const profile = mkdtempSync(join(tmpdir(), 'muten-dev-errors-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 8000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };

try {
  await pause(1500);
  ok('started on a broken page, the dev server stays up', !exited);
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  await pause(800);
  const shown = await evaluate('document.body.innerText');
  ok('the page shows the error at its file and line', /home\.muten:5/.test(shown || ''), (shown || '').slice(0, 300));
  write('src/pages/home/home.muten', good);
  ok('fixing the file brings the page up, with no restart', await until(`!!document.querySelector('.go')`, 10000), (await evaluate('document.body.innerText') || '').slice(0, 300));
  await evaluate(`document.querySelector('.go').click()`);
  ok('an error in the browser covers the page', await until(`!!document.getElementById('__mu_err')`, 4000));
  const said = await until(`/boom\\.ts:3/.test(document.getElementById('__mu_err')?.innerText || '')`, 4000);
  const overlay = await evaluate(`document.getElementById('__mu_err')?.innerText || ''`);
  ok('…at the app\'s own line (src/lib/boom.ts:3), not the bundle\'s', said, overlay.slice(0, 500));
  ok('…with what it means and what to change', /Something was undefined where `\.a` was read/.test(overlay), overlay.slice(0, 700));
  const report = spawnSync('node', [cli, 'report', '.'], { cwd: app, encoding: 'utf8' });
  const text = readFileSync(join(app, '.muten', 'report.md'), 'utf8');
  ok('muten report writes .muten/report.md', report.status === 0 && text.startsWith('# muten report'), report.stdout + report.stderr);
  ok('…with the last runtime error', /reading 'a'/.test(text), text.slice(0, 400));
  ok('…with muten.config\'s keys but none of its values', /`env`: prod/.test(text) && !text.includes('secret-host'), text);
  // a muten.config that does not parse: dev still starts, on the port the file names, and loads the app once it is fixed
  dev.kill(); await pause(400);
  const config = readFileSync(join(app, 'muten.config'), 'utf8');
  write('muten.config', config.replace(/\n\}\nenv/, '\nenv'));   // dev { … never closed
  const second = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
  let secondExited = false; second.on('exit', () => { secondExited = true; });
  try {
    await pause(2500);
    ok('a muten.config that does not parse: dev stays up', !secondExited);
    const waiting = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => '');
    ok('…on the port the file names, showing the error', /never closed/.test(waiting), waiting.slice(0, 300));
    write('muten.config', config);
    let app2 = '';
    for (let waited = 0; waited < 8000 && !app2.includes('/assets/boot'); waited += 200) { await pause(200); app2 = await fetch(`http://localhost:${port}/`).then((r) => r.text()).catch(() => ''); }
    ok('…and serves the app once it is fixed', app2.includes('/assets/boot'), app2.slice(0, 300));
  } finally { second.kill(); }
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
