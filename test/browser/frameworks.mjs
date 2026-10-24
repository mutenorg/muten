// Vue, Svelte 5 and Solid components as islands (framework-island.ts), with the real frameworks, in headless Chrome
// (skipped when there is no Chrome, or when npm cannot install the frameworks from its cache or the registry). Each
// library is a local package the test writes: Vue's as a render function, Svelte's compiled by Svelte's own compiler
// here, Solid's as plain DOM under its reactivity, so what is tested is what an npm library ships: compiled JS.
//   · a prop changes in muten → each component shows it, through its own framework's reactivity, not mounted again;
//   · an event of the component (`on(pick: pick)`) runs the muten action with what it sent;
//   · muten bundle's report says each framework loads later, on its route (ship-report.ts).
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../dist/bin/muten.js', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

const app = mkdtempSync(join(tmpdir(), 'muten-frameworks-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('package.json', '{"name":"fw","private":true,"type":"module"}\n');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(npm, ['install', '--prefer-offline', '--no-audit', '--no-fund', 'vue@3', 'svelte@5', 'solid-js@1'], { cwd: app, encoding: 'utf8' });
if (install.status !== 0) { console.log('- skipped: npm could not install vue, svelte and solid-js'); rmSync(app, { recursive: true, force: true }); process.exit(0); }

const port = 48000 + Math.floor(Math.random() * 2000);
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fw</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('muten.config', `dev {\n  port ${port}\n  devtools false\n}\n`);
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('node_modules/vue-lib/package.json', '{"name":"vue-lib","version":"1.0.0","type":"module","main":"index.js"}\n');
write('node_modules/vue-lib/index.js', `import { h } from 'vue';
export const VueBadge = { props: ['label'], emits: ['pick'], setup(props, { emit }) {
  window.__mounts = window.__mounts || {}; window.__mounts.vue = (window.__mounts.vue || 0) + 1;
  return () => h('button', { class: 'vue-out', onClick: () => emit('pick', 'vue ' + props.label) }, 'vue:' + props.label);
} };\n`);
const { compile } = createRequire(join(app, 'package.json'))('svelte/compiler');
write('node_modules/svelte-lib/package.json', '{"name":"svelte-lib","version":"1.0.0","type":"module","main":"index.js"}\n');
write('node_modules/svelte-lib/Badge.js', compile(`<script>
  let { label, onpick } = $props();
  window.__mounts = window.__mounts || {}; window.__mounts.svelte = (window.__mounts.svelte || 0) + 1;
</script>
<button class="svelte-out" onclick={() => onpick?.('svelte ' + label)}>svelte:{label}</button>`, { generate: 'client', filename: 'Badge.svelte' }).js.code);
write('node_modules/svelte-lib/index.js', "export { default as SvelteBadge } from './Badge.js';\n");
write('node_modules/solid-lib/package.json', '{"name":"solid-lib","version":"1.0.0","type":"module","main":"index.js"}\n');
write('node_modules/solid-lib/index.js', `import { createEffect } from 'solid-js';
export function SolidBadge(props) {
  window.__mounts = window.__mounts || {}; window.__mounts.solid = (window.__mounts.solid || 0) + 1;
  const button = document.createElement('button'); button.className = 'solid-out';
  createEffect(() => { button.textContent = 'solid:' + props.label; });
  button.onclick = () => props.onPick && props.onPick('solid ' + props.label);
  return button;
}\n`);
write('src/pages/home/home.muten', `screen home
use vue VueBadge from "vue-lib"
use svelte SvelteBadge from "svelte-lib"
use solid SolidBadge from "solid-lib"
state { n = 0 : number  picked = "" : text }
action bump mutates n { n.set(n + 1) }
action pick(what: text) mutates picked { picked.set(what) }
Page {
  Button "bump" -> bump class("bump")
  VueBadge(label: n) on(pick: pick)
  SvelteBadge(label: n) on(pick: pick)
  SolidBadge(label: n) on(pick: pick)
  Span "{picked}" class("picked")
}
`);

const check = spawnSync('node', [cli, 'check', '.'], { cwd: app, encoding: 'utf8' });
ok('muten check accepts `use vue`, `use svelte` and `use solid`', check.status === 0, check.stdout + check.stderr);

const dev = spawn('node', [cli, 'dev', '.'], { cwd: app, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((done) => { let said = ''; dev.stdout.on('data', (d) => { said += d; if (said.includes('localhost:')) done(); }); setTimeout(done, 15000); });
const profile = mkdtempSync(join(tmpdir(), 'muten-frameworks-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const cdpPort = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map(); const errors = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expression, ms = 10000) => { for (let waited = 0; waited < ms; waited += 100) { if (await evaluate(expression)) return true; await pause(100); } return false; };
const textOf = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

try {
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${port}/` });
  const drawn = await until(`!!document.querySelector('.vue-out') && !!document.querySelector('.svelte-out') && !!document.querySelector('.solid-out')`);
  ok('the three islands mount', drawn, JSON.stringify({ errors, html: await evaluate('document.body.innerHTML.slice(0, 600)') }));
  ok('each shows its prop', (await textOf('.vue-out')) === 'vue:0' && (await textOf('.svelte-out')) === 'svelte:0' && (await textOf('.solid-out')) === 'solid:0', [await textOf('.vue-out'), await textOf('.svelte-out'), await textOf('.solid-out')].join(' '));
  await evaluate(`document.querySelector('.bump').click()`); await evaluate(`document.querySelector('.bump').click()`);
  await until(`document.querySelector('.solid-out')?.textContent === 'solid:2' && document.querySelector('.vue-out')?.textContent === 'vue:2' && document.querySelector('.svelte-out')?.textContent === 'svelte:2'`, 3000);
  ok('a muten state changes → every component shows it', (await textOf('.vue-out')) === 'vue:2' && (await textOf('.svelte-out')) === 'svelte:2' && (await textOf('.solid-out')) === 'solid:2', [await textOf('.vue-out'), await textOf('.svelte-out'), await textOf('.solid-out')].join(' '));
  const mounts = await evaluate('JSON.stringify(window.__mounts)');
  ok('…through its own reactivity: each was mounted once', JSON.stringify(JSON.parse(mounts || '{}'), ['vue', 'svelte', 'solid']) === '{"vue":1,"svelte":1,"solid":1}', mounts);
  for (const [cls, said] of [['.vue-out', 'vue 2'], ['.svelte-out', 'svelte 2'], ['.solid-out', 'solid 2']]) {
    await evaluate(`document.querySelector(${JSON.stringify(cls)}).click()`); await pause(150);
    ok(`an event of the ${cls.slice(1, -4)} component runs the muten action with what it sent`, (await textOf('.picked')) === said, await textOf('.picked'));
  }
  ok('no error on the page', errors.length === 0, errors.join(' | '));
  const bundled = spawnSync('node', [cli, 'bundle', '.'], { cwd: app, encoding: 'utf8' });
  ok('muten bundle says the frameworks load later, on the route whose island wakes, not on every route', /vue[^\n]*later, on \//.test(bundled.stdout) && /solid[^\n]*later, on \//.test(bundled.stdout), bundled.stdout + bundled.stderr);
} finally {
  dev.kill(); ws.close(); browser.kill();
  await pause(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
