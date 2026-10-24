// muten.config `lint { }` and `budget { }`: a finding set off, a warning raised to an error, a code that does not exist
// said with the nearest one, and a bundle that ships more than its budget stopped, saying what weighs most.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'muten-config-blocks-'));
const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const run = (args) => { try { return { code: 0, out: execFileSync('node', [cli, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (error) { return { code: error.status, out: String(error.stdout) + String(error.stderr) }; } };
const check = () => JSON.parse(run(['check', '.', '--json']).out);
write('index.html', '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/pages/home/home.muten', 'screen home\nPage {\n  Title "Uno"\n  Title "Dos"\n}\n');   // two h1: a warning
try {
  ok('without lint {}, the finding is a warning', check().some((d) => d.code === 'heading-many-h1' && d.severity === 'warning'));
  write('muten.config', 'lint {\n  heading-many-h1 off\n}\n');
  ok('lint { code off } leaves it out', !check().some((d) => d.code === 'heading-many-h1'), JSON.stringify(check()));
  write('muten.config', 'lint {\n  heading-many-h1 error\n}\n');
  ok('lint { code error } makes it an error (check fails)', check().some((d) => d.code === 'heading-many-h1' && d.severity === 'error') && run(['check', '.']).code === 1);
  write('muten.config', 'lint {\n  heading-many-h2 off\n}\n');
  ok('a code that does not exist is said, with the nearest one', check().some((d) => d.code === 'config-key' && d.fix?.to === 'heading-many-h1'), JSON.stringify(check()));
  write('muten.config', 'budget {\n  js "1kb"\n}\n');
  const over = run(['bundle', '.']);
  ok('a route over its JS budget stops the bundle, saying what weighs most', over.code !== 0 && /over budget/.test(over.out) && /ships .* of JS \(budget 1\.0 KB\); heaviest: /.test(over.out), over.out.slice(-400));
  write('muten.config', 'budget {\n  js "900kb"\n}\n');
  ok('…and passes under it', run(['bundle', '.']).code === 0);
  write('muten.config', 'budget {\n  js "mucho"\n}\n');
  ok('a budget that is no size is a finding', check().some((d) => d.code === 'config-value' && /budget\.js/.test(d.message)));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
