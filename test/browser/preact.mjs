// `islands { react "preact" }`: React islands on preact/compat (bundle-options.ts). A React component with a hook,
// from a local package that imports `react` like any library, bundled both ways (skipped when there is no Chrome, or
// npm cannot install react, react-dom and preact):
//   · with Preact the bundle carries no React DOM, and is much lighter;
//   · the component renders and its state works (a click counts) on Preact;
//   · check says when preact is not installed.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-preact-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('package.json', '{"name":"pa","private":true}\n');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install', '--prefer-offline', '--no-audit', '--no-fund', 'react@18', 'react-dom@18'], { cwd: app, encoding: 'utf8' });
if (install.status !== 0) { console.log('- skipped: npm could not install react and react-dom'); rmSync(app, { recursive: true, force: true }); process.exit(0); }
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>p</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
const writeLibrary = () => { write('node_modules/tally-lib/package.json', '{"name":"tally-lib","version":"1.0.0","type":"module","main":"index.js"}\n');
write('node_modules/tally-lib/index.js', `import { createElement, useState } from 'react';
export function Tally(props) {
  const [count, setCount] = useState(props.start || 0);
  return createElement('button', { className: 'tally', onClick: () => setCount(count + 1) }, props.label + ' ' + count);
}\n`); };
writeLibrary();
write('src/pages/home/home.muten', 'screen home\nuse Tally from "tally-lib"\nPage {\n  Tally(label: "taps", start: 1)\n}\n');

const bundle = () => { rmSync(join(app, 'dist'), { recursive: true, force: true }); const run = spawnSync('node', [cli, 'bundle', '.'], { cwd: app, encoding: 'utf8' }); const dir = join(app, 'dist', 'assets'); const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js')) : []; const code = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'); return { run, code, gz: files.reduce((sum, f) => sum + gzipSync(readFileSync(join(dir, f))).length, 0) }; };

const onReact = bundle();
ok('the React bundle builds', onReact.run.status === 0, onReact.run.stdout + onReact.run.stderr);
write('muten.config', 'islands {\n  react "preact"\n}\n');
const unchecked = spawnSync('node', [cli, 'check', '.'], { cwd: app, encoding: 'utf8' });
ok('check says preact is not installed', /npm i preact/.test(unchecked.stdout + unchecked.stderr), unchecked.stdout + unchecked.stderr);
const more = spawnSync(npm, ['install', '--prefer-offline', '--no-audit', '--no-fund', 'preact@10'], { cwd: app, encoding: 'utf8' });
if (more.status !== 0) { console.log('- skipped the rest: npm could not install preact'); rmSync(app, { recursive: true, force: true }); process.exit(fails ? 1 : 0); }
writeLibrary();   // npm prunes a package it did not install
const onPreact = bundle();
ok('the Preact bundle builds', onPreact.run.status === 0, onPreact.run.stdout + onPreact.run.stderr);
// preact/compat shims React's __SECRET_INTERNALS; what only React DOM has is its error decoder and its scheduler
const REACT_DOM = /Minified React error|unstable_scheduleCallback/;
ok('the React bundle carries React DOM (the marker is real)', REACT_DOM.test(onReact.code));
ok('the Preact one does not', !REACT_DOM.test(onPreact.code), (onPreact.code.match(/.{40}(?:Minified React error|unstable_scheduleCallback).{20}/) || [''])[0]);
ok(`it is much lighter (${(onReact.gz / 1024).toFixed(1)} KB gz → ${(onPreact.gz / 1024).toFixed(1)} KB gz)`, onPreact.gz > 0 && onPreact.gz < onReact.gz / 2, `${onReact.gz} → ${onPreact.gz}`);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = createServer((req, res) => {
  const path = join(app, 'dist', (req.url || '/').split('?')[0]);
  const file = existsSync(path) && extname(path) ? path : join(app, 'dist', 'index.html');
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const profile = mkdtempSync(join(tmpdir(), 'muten-preact-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
try {
  const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
  let id = 0; const waiting = new Map(); const errors = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); waiting.get(m.id)?.(m); });
  const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const until = async (expression, ms = 6000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  ok('the component renders on Preact', await until(`document.querySelector('.tally')?.textContent === 'taps 1'`), JSON.stringify({ errors, text: await evaluate(`document.querySelector('.tally')?.textContent ?? document.body.innerHTML.slice(0, 300)`) }));
  await evaluate(`document.querySelector('.tally').click()`);
  ok('…and its state works (a click counts)', await until(`document.querySelector('.tally')?.textContent === 'taps 2'`, 2000), await evaluate(`document.querySelector('.tally')?.textContent`));
  ok('no error on the page', errors.length === 0, errors.join(' | '));
  ws.close();
} finally {
  browser.kill(); server.close();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
