// `muten add <package>` for a package that is not a muten plugin: installed with the app's package manager, refused
// when it needs Node, and answered with the `use` line its own types call for. Offline: the packages are local folders
// installed as `file:` specs, so npm never reaches the registry.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
let fails = 0;
const ok = (label: string, cond: boolean, extra = ''): void => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

const root = mkdtempSync(join(tmpdir(), 'muten-add-'));
const write = (path: string, text: string): void => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
write('app/package.json', '{"name":"app","private":true}\n');
write('app/src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('stamp/package.json', '{"name":"stamp","version":"1.0.0","main":"index.js","types":"index.d.ts","style":"stamp.css"}\n');
write('stamp/index.js', 'module.exports = function stamp(x) { return "[" + x + "]"; };\nmodule.exports.twice = (x) => x + x;\n');
write('stamp/index.d.ts', 'declare function stamp(x: string): string;\ndeclare namespace stamp { function twice(x: string): string; }\nexport = stamp;\n');
write('stamp/stamp.css', '.stamp { color: red }\n');
write('serverish/package.json', '{"name":"serverish","version":"1.0.0","main":"index.js"}\n');
write('serverish/index.js', 'module.exports = require("./lib.js");\n');
write('serverish/lib.js', 'const zlib = require("zlib");\nmodule.exports.pack = (x) => zlib.gzipSync(x);\n');

const add = (spec: string): { code: number; said: string } => {
  const run = spawnSync('node', [cli, 'add', spec], { cwd: join(root, 'app'), encoding: 'utf8' });
  return { code: run.status ?? 1, said: run.stdout + run.stderr };
};

try {
  const stamp = add('file:../stamp');
  ok('a package that is itself a function is used by its own name', /use stamp from "stamp"/.test(stamp.said), stamp.said);
  ok('its stylesheet is offered as a `use "…"` line', /use "stamp\/stamp\.css"/.test(stamp.said), stamp.said);
  ok('its other functions are named', /also exports twice/.test(stamp.said), stamp.said);
  ok('its weight is said', /KB gzipped/.test(stamp.said), stamp.said);
  ok('the command succeeds', stamp.code === 0, String(stamp.code));
  const server = add('file:../serverish');
  ok('a package that needs Node (even past its entry file) is refused, saying which module', /needs Node's `zlib`/.test(server.said), server.said);
  ok('and the command fails', server.code !== 0, String(server.code));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
