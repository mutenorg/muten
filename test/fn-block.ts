// `fn name(…): T { … }`: TypeScript written in a .muten file. The lexer reads the signature and body as text (braces
// counted outside strings, templates and comments), the parser keeps the name and how it is called, `check` knows it
// as a function, and the loader strips its types (the page runs it: test/browser is not needed, the bundle is checked).
// And `every 1m { … }`, statements on a beat (the page's clock, with no Custom).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parse } from '../dist/engine/lang/parse.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const FN = 'fn finalPrice(amount: number, where?: string, ...rest: number[]): number {\n  const label = `${where ?? "}"}` // a } in a comment\n  const brace = "}"\n  return amount === 0 ? 0 : Math.round(amount * 1.19) + label.length * 0\n}\n';
const ir = parse('screen home\n' + FN + 'Page {\n  Text "{finalPrice(1)}"\n}\n');
const fn = ir.tsFns?.finalPrice;
ok('the body is read whole, braces in strings, templates and comments included', Boolean(fn) && fn.source.endsWith('label.length * 0\n}') && ir.tree?.type === 'Page', JSON.stringify(fn?.source));
ok('its parameters, and how many must be passed', fn?.params.join() === 'amount,where,rest' && fn.required === 1, JSON.stringify(fn));
const beat = parse('screen home\nstate { n = 0 : number }\nevery 1m {\n  n.set(n + 1)\n}\nPage {\n  Text "{n}"\n}\n');
ok('`every 1m { … }` is a beat with its statements', beat.timers?.length === 1 && beat.timers[0].ms === 60000 && beat.timers[0].body.length === 1, JSON.stringify(beat.timers));
const settled = parse('screen home\nstate { q = "" : text  asked = "" : text }\nsettle q 300ms {\n  asked.set(q)\n}\nPage {\n  SearchField bind(q) "Buscar"\n}\n');
ok('`settle q 300ms { … }` watches its value, with its time and statements', settled.settles?.length === 1 && settled.settles[0].ms === 300 && settled.settles[0].watched.name === 'q' && settled.settles[0].body.length === 1, JSON.stringify(settled.settles));
ok('`fn` only declares at the start of a line (a state may be called fn)', parse('screen home\nstate { fn = 1 : number }\nPage {\n  Text "{fn}"\n}\n').state.fn?.type === 'number');

const root = mkdtempSync(join(tmpdir(), 'muten-fn-'));
const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
const check = () => { try { return JSON.parse(execFileSync('node', [cli, 'check', '.', '--json'], { cwd: root, encoding: 'utf8' })); } catch (error) { return JSON.parse(error.stdout); } };
write('index.html', '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
try {
  write('src/pages/home/home.muten', 'screen home\n' + FN + 'Page {\n  Text "{finalPrice(1)}"\n}\n');
  ok('check knows a fn as a function', JSON.stringify(check()) === '[]', JSON.stringify(check()));
  write('src/pages/home/home.muten', 'screen home\n' + FN + 'Page {\n  Text "{finalPrice()}"\n}\n');
  ok('…and how many values it takes', check().some((d) => d.code === 'fn-arity'), JSON.stringify(check()));
  write('src/pages/home/home.muten', 'screen home\n' + FN.replace('Math.round(', 'Math.round((') + 'Page {\n  Text "{finalPrice(1)}"\n}\n');
  const bad = check();
  ok('a body TypeScript cannot read is a finding inside the fn, with what TypeScript said', bad.length === 1 && bad[0].loc.line >= 2 && bad[0].loc.line <= 7 && /TypeScript/.test(bad[0].message), JSON.stringify(bad));
  write('src/pages/home/home.muten', 'screen home\n' + FN + 'Page {\n  Text "{finalPrice(1)}" class("total")\n}\n');
  execFileSync('node', [cli, 'bundle', '.'], { cwd: root, encoding: 'utf8' });
  const js = execFileSync('sh', ['-c', 'cat dist/assets/home-*.js'], { cwd: root, encoding: 'utf8' });
  ok('the page ships it as JavaScript, its types stripped', /Math\.round/.test(js) && !/amount: number/.test(js));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
