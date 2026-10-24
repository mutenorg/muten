// `muten check --json` puts every finding where it is written, and always answers with JSON. Run as an agent runs it
// (the CLI, its stdout through a pipe), on a small app whose one part is called from two pages:
//   · a slip inside the part is said once, in the part's file, at its line and column (it was said once per call, in
//     every page that called the part, with no line);
//   · a slip in an argument is the page's, at the call, at the word;
//   · a `$name` in the part that is not one of its parameters is the part's, with the near parameter;
//   · a store that does not parse is a finding, not text on stderr with nothing on stdout;
//   · a swapped pair of letters (`tilte`) suggests the word it came from;
//   · a long answer arrives whole through a pipe (it was cut off at 64 kB);
//   · a part nobody calls is checked all the same (its mistakes waited for the day a page called it);
//   · an argument the part does not take is said at every call, and the rest of the page is still checked;
//   · a `Custom` with nothing to mount is a finding (bundle skipped it and left an empty box);
//   · a parameter's type is a type (an action's, a store action's, a part's), said at the word.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'muten-places-'));
const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const check = () => {
  let out;
  try { out = execFileSync('node', [cli, 'check', '.', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }); }
  catch (error) { out = error.stdout; }
  try { return JSON.parse(out); } catch { return null; }
};

const PART = 'part Box(label: text) {\n  Stack {\n    Text "{$label}"\n  }\n}\n';
const page = (name, arg) => `screen ${name}\nstate { title = "x" : text }\nPage {\n  Box(label: ${arg})\n  Box(label: title)\n}\n`;
write('index.html', '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n  "/two" -> two\n}\n');
write('src/pages/home/home.muten', page('home', 'title'));
write('src/pages/two/two.muten', page('two', 'title'));
write('src/parts/box.muten', PART);
write('src/notes.store', 'state { items = [] : list<text> }\n');

try {
  ok('a clean app answers with an empty list', JSON.stringify(check()) === '[]', JSON.stringify(check()));

  write('src/parts/box.muten', PART.replace('  Stack {', '  Stakc {'));
  let found = check();
  ok('a slip inside a part is said once, though four calls inline it', found?.length === 1, JSON.stringify(found));
  ok('…in the part\'s file, at the word', found?.[0]?.file === 'src/parts/box.muten' && found[0].loc?.line === 2 && found[0].loc.col === 3, JSON.stringify(found?.[0]));
  ok('…with its fix', found?.[0]?.fix?.from === 'Stakc' && found[0].fix.to === 'Stack', JSON.stringify(found?.[0]?.fix));
  write('src/parts/box.muten', PART);

  write('src/pages/two/two.muten', page('two', 'tilte'));
  found = check();
  ok('a slip in an argument is the page\'s, at the call', found?.length === 1 && found[0].file === 'src/pages/two/two.muten' && found[0].loc?.line === 4, JSON.stringify(found));
  ok('…at the word itself', found?.[0]?.loc?.col === 14, JSON.stringify(found?.[0]?.loc));
  ok('…and a swapped pair of letters suggests the word it came from', found?.[0]?.fix?.to === 'title', JSON.stringify(found?.[0]?.fix));
  write('src/pages/two/two.muten', page('two', 'title'));

  write('src/parts/box.muten', PART.replace('{$label}', '{$lable}'));
  found = check();
  ok('a `$name` that is no parameter is the part\'s finding', found?.length === 1 && found[0].code === 'unknown-param' && found[0].file === 'src/parts/box.muten' && found[0].loc?.line === 3, JSON.stringify(found));
  ok('…with the near parameter as its fix', found?.[0]?.fix?.from === '$lable' && found[0].fix.to === '$label', JSON.stringify(found?.[0]?.fix));
  ok('…and no echo in the pages that call it', found?.length === 1, JSON.stringify(found));
  write('src/parts/box.muten', PART);

  write('src/notes.store', 'state { items = [] : list<text> }\naction add(x: text) mutaets items { items.push(x) }\n');
  found = check();
  ok('a store that does not parse is a finding in --json', found?.length === 1 && found[0].code === 'syntax' && found[0].file === 'src/notes.store' && found[0].loc?.line === 2, JSON.stringify(found));
  write('src/notes.store', 'state { items = [] : list<text> }\n');

  write('src/parts/spare.muten', 'part Spare() {\n  Stack {\n    Txet "hola"\n  }\n}\n');
  found = check();
  ok('a part nobody calls is checked too, in its file', found?.length === 1 && found[0].file === 'src/parts/spare.muten' && found[0].loc?.line === 3 && found[0].fix?.to === 'Text', JSON.stringify(found));
  rmSync(join(root, 'src/parts/spare.muten'));

  write('src/pages/two/two.muten', page('two', 'title').replace('Box(label: title)\n}', 'Box(label: title, lable: title)\n  Box(lable: title)\n  Txet "x"\n}'));
  found = check();
  const stray = (found || []).filter((d) => d.code === 'unknown-arg');
  ok('an argument the part does not take is said at each call', stray.length === 2 && stray.every((d) => d.file === 'src/pages/two/two.muten') && stray.map((d) => d.loc?.line).join() === '5,6', JSON.stringify(found));
  ok('…and the rest of the page is still checked', (found || []).some((d) => d.code === 'unknown-type' && d.loc?.line === 7), JSON.stringify(found));
  write('src/pages/two/two.muten', page('two', 'title'));

  write('src/parts/box.muten', PART.replace('    Text "{$label}"', '    Text "{$label}"\n    Custom Tikcer'));
  write('src/components/Ticker.js', 'export function mount() {}\n');
  found = check();
  ok('a Custom with nothing to mount is a finding, at its line in the part', found?.length === 1 && found[0].code === 'unknown-component' && found[0].file === 'src/parts/box.muten' && found[0].loc?.line === 4 && found[0].fix?.to === 'Ticker', JSON.stringify(found));
  write('src/parts/box.muten', PART);

  write('src/parts/box.muten', PART.replace('part Box(label: text)', 'part Box(label: txet)'));
  write('src/notes.store', 'state { items = [] : list<text> }\naction add(x: nubmer) mutates items { items.push("a") }\n');
  found = check();
  const types = (found || []).filter((d) => d.code === 'unknown-type').map((d) => `${d.file}:${d.loc?.line}:${d.loc?.col}>${d.fix?.to}`).sort().join(' ');
  ok('a parameter\'s type is checked in parts and store actions, at the word', types === 'src/notes.store:2:15>number src/parts/box.muten:1:17>text', JSON.stringify(found));
  write('src/parts/box.muten', PART);
  write('src/notes.store', 'state { items = [] : list<text> }\n');

  write('src/pages/two/two.muten', `screen two\nPage {\n${'  Text "{nope}"\n'.repeat(900)}}\n`);
  found = check();
  ok('a long answer arrives whole through a pipe', found?.length === 900, found ? String(found.length) : 'not JSON');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
