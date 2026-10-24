// What a page carries that does nothing, or that not everyone gets (warnings): a state nothing
// uses, an action nothing calls, words written in the page while the app speaks through src/lang. And what must not be
// said: a name of one word (WhatsApp), an address (storio.ink/x), a t("key").
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };
const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'muten-hygiene-'));
const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const check = () => { try { return JSON.parse(execFileSync('node', [cli, 'check', '.', '--json'], { cwd: root, encoding: 'utf8' })); } catch (error) { return JSON.parse(error.stdout); } };
write('index.html', '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/lang/es.lang', 'hello "Hola a todos"\n');
write('src/lang/en.lang', 'hello "Hello everyone"\n');
write('src/pages/home/home.muten', [
  'screen home',
  'state { used = 0 : number  idle = 0 : number }',
  'action bump mutates used { used.set(used + 1) }',
  'action spare mutates used { used.set(0) }',
  'Page {',
  '  Title "{t("hello")}"',
  '  Text "Escrito a mano aqui"',
  '  Span "WhatsApp"',
  '  Span "storio.ink/bruma"',
  '  Button "{used}" -> bump',
  '}',
  ''].join('\n'));
try {
  const found = check();
  const at = (code) => found.filter((d) => d.code === code).map((d) => d.loc?.line).join();
  ok('a state nothing uses', at('unused-state') === '2' && found.some((d) => d.code === 'unused-state' && d.word === 'idle'));
  ok('an action nothing calls', found.some((d) => d.code === 'unused-action' && d.word === 'spare') && !found.some((d) => d.word === 'bump'));
  ok('words written in the page while the app speaks through src/lang (not a name, an address, a t("key"))', at('text-not-translated') === '7', JSON.stringify(found.filter((d) => d.code === 'text-not-translated')));
  ok('all of them warnings', found.every((d) => d.severity === 'warning'), JSON.stringify(found.filter((d) => d.severity !== 'warning')));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
