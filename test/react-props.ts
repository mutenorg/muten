// A React component's props, checked by TypeScript against the component's own declared props (ts-check.ts): a prop it
// does not have, a required one left out, events as onX. Only when the app has React's types: without them, silence.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };
const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'muten-react-props-'));
const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const check = () => { try { return JSON.parse(execFileSync('node', [cli, 'check', '.', '--json'], { cwd: root, encoding: 'utf8' })); } catch (error) { return JSON.parse(error.stdout); } };
const page = (call) => `screen home\nstate { n = 0 : number }\nuse Badge from "badges"\nPage {\n  ${call}\n  Text "{n}"\n}\naction go mutates n { n.set(1) }\n`;
write('index.html', '<!doctype html><html><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('node_modules/badges/package.json', '{ "name": "badges", "version": "0.0.0", "main": "index.js", "types": "index.d.ts" }');
write('node_modules/badges/index.js', 'export function Badge() { return null; }\n');
write('node_modules/badges/index.d.ts', 'export declare function Badge(props: { label: string; tone?: "warm" | "cold"; onPick?: (id: string) => void }): any;\n');
symlinkSync(new URL('../node_modules/typescript', import.meta.url).pathname, join(root, 'node_modules', 'typescript'));
try {
  write('src/pages/home/home.muten', page('Badge(lable: "hola") on(pick: go)'));
  ok('without React\'s types nothing is said (no guess)', !check().some((d) => d.code === 'package-type'));
  write('node_modules/@types/react/package.json', '{ "name": "@types/react", "version": "0.0.0", "types": "index.d.ts" }');
  write('node_modules/@types/react/index.d.ts', 'export type ComponentProps<T> = T extends (props: infer P) => any ? P : never;\n');
  let found = check().filter((d) => d.code === 'package-type');
  ok('a prop the component does not have', found.length === 1 && /lable/.test(found[0].message) && found[0].loc?.line === 5, JSON.stringify(found));
  write('src/pages/home/home.muten', page('Badge(tone: "warm")'));
  found = check().filter((d) => d.code === 'package-type');
  ok('a required prop left out', found.length === 1 && /'label' is missing/.test(found[0].message), JSON.stringify(found));
  write('src/pages/home/home.muten', page('Badge(label: "hola", tone: "warm") on(pick: go)'));
  ok('right props, and on(pick) read as onPick: nothing to say', !check().some((d) => d.code === 'package-type'), JSON.stringify(check()));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
