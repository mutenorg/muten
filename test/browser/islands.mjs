// React islands that wake (runtime-island.ts, react-tree.ts reactLoader) against a real browser (headless Chrome;
// skipped when there is none). The app carries a minimal React of its own (CommonJS, like the real one: a dynamic
// import of it only has `default`), so what is tested is muten's part:
//   · the page runs without asking for React; an island far below asks for it only when its place nears the screen;
//   · an island on the first screen renders at once, through the CommonJS bridge;
//   · while prerender draws a page (__mutenWakeAll) every island renders;
//   · a part with its own `use react` mounts its island on a page that imports nothing;
//   · a plain `use Badge`, written where an element goes, is a React component (no `react` needed).
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const dist = new URL('../../dist/', import.meta.url).pathname;
const chrome = process.env.CHROME_PATH || ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

// ── the app, with its own tiny React ──
const app = mkdtempSync(join(tmpdir(), 'muten-islands-'));
const write = (path, text) => { mkdirSync(join(app, path, '..'), { recursive: true }); writeFileSync(join(app, path), text); };
write('node_modules/react/package.json', '{ "name": "react", "version": "0.0.0-test", "main": "index.js" }');
write('node_modules/react/index.js', 'exports.createElement = function (type, props) { return { type: type, props: props || {}, children: [].slice.call(arguments, 2) }; };\n');
write('node_modules/react-dom/package.json', '{ "name": "react-dom", "version": "0.0.0-test", "main": "index.js" }');
write('node_modules/react-dom/index.js', 'module.exports = {};\n');
write('node_modules/react-dom/client.js', [
  'function build(node) {',
  '  if (node == null || node === false) return document.createTextNode("");',
  '  if (typeof node !== "object") return document.createTextNode(String(node));',
  '  if (typeof node.type === "function") return build(node.type(Object.assign({}, node.props, { children: node.children })));',
  '  var el = document.createElement(node.type);',
  '  if (node.props.className) el.className = node.props.className;',
  '  node.children.forEach(function (child) { el.appendChild(build(child)); });',
  '  return el;',
  '}',
  'exports.createRoot = function (host) { return { render: function (tree) { host.replaceChildren(build(tree)); }, unmount: function () { host.replaceChildren(); } }; };',
].join('\n'));
write('node_modules/badges/package.json', '{ "name": "badges", "version": "0.0.0-test", "type": "module", "main": "index.js" }');
write('node_modules/badges/index.js', 'import { createElement } from "react";\nexport function Badge(props) { return createElement("b", { className: "badge " + (props.className || "") }, props.label); }\n');
write('index.html', '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>islands</title>\n</head>\n<body>\n  <div id="app"></div>\n  <script type="module" src="/src/app.muten"></script>\n</body>\n</html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n  "/top" -> top\n  "/chip" -> chip\n  "/plain" -> plain\n}\n');
write('src/pages/plain/plain.muten', 'screen plain\nuse Badge from "badges"\nPage {\n  Badge(label: "sin apellido", className: "plain-badge")\n  Title "use sin react"\n}\n');
write('src/parts/chip.muten', 'use react Badge from "badges"\npart Chip(label: text) {\n  Badge(label: $label, className: "part-badge")\n}\n');
write('src/pages/chip/chip.muten', 'screen chip\nPage {\n  Chip(label: "desde un part")\n  Title "Part con su propio use react"\n}\n');
write('src/pages/home/home.muten', 'screen home\nuse react Badge from "badges"\nPage {\n  Title "Arriba"\n  Stack class("spacer") { Text "espacio" }\n  Stack class("far") { Badge(label: "lejos", className: "far-badge") }\n}\n');
write('src/pages/top/top.muten', 'screen top\nuse react Badge from "badges"\nPage {\n  Badge(label: "cerca", className: "near-badge")\n  Title "Primera pantalla"\n}\n');
write('src/styles.css', '.spacer { height: 6000px; }\n');
const { bundleEsbuild } = await import(join(dist, 'esbuild-muten.js'));
const out = join(app, 'dist');
await bundleEsbuild(app, out, { quiet: true });

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
const profile = mkdtempSync(join(tmpdir(), 'muten-islands-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map(); const problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map((a) => a.value || a.description).join(' '));
  waiting.get(m.id)?.(m);
});
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (expression, ms = 5000) => { for (let waited = 0; waited < ms; waited += 50) { if (await evaluate(expression)) return true; await pause(50); } return false; };
const reactAsked = () => served.some((path) => /\/assets\/(react|client)-[\w-]+\.js$/.test(path));
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 800, deviceScaleFactor: 1, mobile: false });

try {
  served.length = 0;
  await send('Page.navigate', { url: base + '/' });
  ok('the page runs without React', await until(`document.body.innerText.includes('Arriba')`));
  await pause(600);
  ok('an island far below has not asked for React yet', !reactAsked() && (await evaluate(`!document.querySelector('.far-badge')`)), served.join(' '));
  await evaluate(`document.querySelector('.far').scrollIntoView()`);
  ok('…and renders once its place nears the screen', await until(`document.querySelector('.far-badge')?.textContent === 'lejos'`), await evaluate(`document.querySelector('.far')?.outerHTML`));
  ok('…having asked for React then', reactAsked());

  await send('Page.navigate', { url: base + '/top' });
  ok('an island on the first screen renders at once, through the CommonJS bridge', await until(`document.querySelector('.near-badge')?.textContent === 'cerca'`, 3000));

  await send('Page.navigate', { url: base + '/chip' });
  ok('a part with its own `use react` mounts its island on a page that imports nothing', await until(`document.querySelector('.part-badge')?.textContent === 'desde un part'`, 3000), await evaluate(`document.querySelector('main')?.innerHTML`));

  await send('Page.navigate', { url: base + '/plain' });
  ok('a plain `use` written where an element goes mounts as a React island', await until(`document.querySelector('.plain-badge')?.textContent === 'sin apellido'`, 3000), await evaluate(`document.querySelector('main')?.innerHTML`));

  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__mutenWakeAll = true;' });
  await send('Page.navigate', { url: base + '/' });
  ok('while prerender draws, every island renders without being seen', await until(`document.querySelector('.far-badge')?.textContent === 'lejos'`, 3000));
  ok('no error on the way', problems.length === 0, problems.join(' | '));
} finally {
  ws.close(); browser.kill(); server.close();
  await pause(200);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(app, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
