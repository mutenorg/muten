// The keyed `each` against random list edits, in a real browser (headless Chrome; skipped when there is none).
// Two compiled pages: rows with an id, and a list of texts with repeats. After each random edit (insert, remove,
// move, replace a row's label, shuffle, clear) the screen must show exactly the list, in order, and a row whose id
// survived the edit must keep its own DOM element (moved, never rebuilt: that is what keeps focus and input state).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const dist = new URL('../../dist/', import.meta.url).pathname;
const chrome = ['google-chrome-stable', 'google-chrome', 'chromium'].map((name) => { try { return execFileSync('which', [name]).toString().trim(); } catch { return ''; } }).find(Boolean);
if (!chrome) { console.log('- skipped: no Chrome/Chromium on this machine'); process.exit(0); }

const { parse } = await import(join(dist, 'engine/lang/parse.js'));
const { toDoc } = await import(join(dist, 'engine/ir/flatten.js'));
const { compileModule } = await import(join(dist, 'engine/compile/compile.js'));
const page = (src) => compileModule(toDoc(parse(src)), {}, '', {}, {}, { dev: true }).replace("from 'virtual:muten/runtime'", "from '/rt/runtime.js'");
const pages = {
  '/rows.js': page('screen s\nentity Row { label text }\nstate { items = [] : list<Row> }\nPage { List { each items as r { Text "{r.label}" class("row") } } }'),
  '/texts.js': page('screen s\nstate { items = [] : list<text> }\nPage { each items as t { Span "{t}" class("row") } }'),
};
const html = (module) => `<!doctype html><div id="app"></div><script>globalThis.__MUTEN_DEV__ = false</script><script type="module">import { mount } from '${module}'; window.page = mount(document.getElementById('app')); window.ready = true;</script>`;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (pages[url]) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(pages[url]); }
  if (url.startsWith('/rt/')) { const file = join(dist, url.slice(4)); if (file.startsWith(dist) && existsSync(file)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(file)); } }
  if (url === '/rows' || url === '/texts') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html(url + '.js')); }
  res.writeHead(404); res.end();
}).listen(0, '127.0.0.1');
await new Promise((done) => server.on('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'muten-fuzz-'));
const browser = spawn(chrome, ['--headless=new', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((done) => { let said = ''; browser.stderr.on('data', (d) => { said += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(said); if (m) done(m[1]); }); });
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((done) => ws.addEventListener('open', done, { once: true }));
let id = 0; const waiting = new Map(); const thrown = [];
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') thrown.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); waiting.get(m.id)?.(m); });
const send = (method, params = {}) => new Promise((done) => { const i = ++id; waiting.set(i, done); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send('Runtime.enable');

// runs inside the page: random edits, each checked against the list it should show
const FUZZ = (withIds, seeds) => `(async () => {
  const items = window.page.__muten.ctx.items;
  const problems = [];
  for (let seed = 1; seed <= ${seeds}; seed++) {
    let s = seed; const random = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (n) => Math.floor(random() * n);
    let next = 1, list = [];
    const make = () => ${withIds} ? { id: next, label: 'r' + next++ } : ['a', 'b', 'c', 'd'][pick(4)];
    items.set([]); await Promise.resolve();
    for (let step = 0; step < 400; step++) {
      const before = new Map(); // row id -> its element, before the edit
      if (${withIds}) for (const el of document.querySelectorAll('.row')) before.set(el.__id, el);
      const op = pick(7);
      list = [...list];
      if (op === 0 || list.length < 2) for (let k = 0, n = 1 + pick(3); k < n; k++) list.splice(pick(list.length + 1), 0, make());
      else if (op === 1) list.splice(pick(list.length), 1 + pick(2));
      else if (op === 2) { const [moved] = list.splice(pick(list.length), 1); list.splice(pick(list.length + 1), 0, moved); }
      else if (op === 3 && ${withIds}) { const at = pick(list.length); list[at] = { ...list[at], label: list[at].label + '*' }; }
      else if (op === 4) list.sort(() => random() - 0.5);
      else if (op === 5 && random() < 0.1) list = [];
      else list.push(make());
      items.set(list);
      await Promise.resolve(); await Promise.resolve();
      const shown = [...document.querySelectorAll('.row')];
      const want = list.map((row) => ${withIds} ? row.label : row);
      const got = shown.map((el) => el.textContent);
      if (JSON.stringify(got) !== JSON.stringify(want)) { problems.push('seed ' + seed + ' step ' + step + ' op ' + op + ': shows ' + JSON.stringify(got) + ', the list is ' + JSON.stringify(want)); break; }
      if (${withIds}) shown.forEach((el, i) => { const row = list[i]; if (before.has(row.id) && before.get(row.id) !== el) problems.push('seed ' + seed + ' step ' + step + ': row ' + row.id + ' was rebuilt, not kept'); el.__id = row.id; });
      if (problems.length > 5) break;
    }
  }
  return problems;
})()`;

let failures = 0;
for (const [path, withIds] of [['/rows', true], ['/texts', false]]) {
  thrown.length = 0;
  await send('Page.navigate', { url: base + path });
  for (let t = 0; t < 50 && !(await evaluate('!!window.ready')); t++) await new Promise((done) => setTimeout(done, 50));
  const problems = (await evaluate(FUZZ(withIds, 30))) || ['the page did not run'];
  if (thrown.length) problems.push('the page threw: ' + thrown[0]);
  failures += problems.length;
  console.log(problems.length ? `✗ ${path}:\n  ${problems.slice(0, 6).join('\n  ')}` : `✓ ${path}: 30 seeds × 400 random edits, the screen is the list${withIds ? ' and every surviving row keeps its element' : ''}`);
}
browser.kill(); server.close(); setTimeout(() => { rmSync(profile, { recursive: true, force: true }); process.exit(failures ? 1 : 0); }, 300);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
