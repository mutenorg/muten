// A Custom written in TypeScript (src/components/Name.ts): found like a .js one, its types stripped where it is
// inlined (or compiled by esbuild when it imports), and each call checked against its own `mount(el, inputs, on)`.
// And `muten map` counts how much of the app is muten and how much JS/TS (code-lines.ts).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../dist/bin/muten.js', import.meta.url).pathname;
let fails = 0;
const ok = (label: string, cond: boolean, extra = ''): void => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

const root = mkdtempSync(join(tmpdir(), 'muten-custom-ts-'));
const write = (path: string, text: string): void => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
write('package.json', '{"name":"app","private":true}\n');
write('index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><div id="app"></div><script type="module" src="/src/app.muten"></script></body></html>\n');
write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
write('src/components/Counter.ts', `interface Inputs { start: number; label?: string }
interface Events { done?: (n: number) => void }
export function mount(el: HTMLElement, inputs: Inputs, on: Events): (next: Inputs) => void {
  let n: number = inputs.start;
  const draw = (): void => { el.textContent = \`\${inputs.label ?? ''}\${n}\`; };
  el.addEventListener('click', () => { n++; draw(); if (n > 3) on.done?.(n); });
  draw();
  return (next: Inputs) => { inputs = next; n = next.start; draw(); };
}
`);
write('src/lib/twice.ts', 'export const twice = (n: number): number => n * 2;\n');
write('src/components/Doubled.ts', `import { twice } from '~/lib/twice.ts';
export function mount(el: HTMLElement, inputs: { value: number }): void { el.textContent = String(twice(inputs.value)); }
`);
const pageWith = (counter: string): void => write('src/pages/home/home.muten', `screen home
state { base = 1 : number  over = 0 : number }
action finish(n: number) mutates over { over.set(n) }
Page {
  ${counter}
  Custom Doubled inputs(value: base)
  Text "{over}"
}
`);
const run = (args: string[]): { code: number; said: string } => { const result = spawnSync('node', [cli, ...args], { cwd: root, encoding: 'utf8' }); return { code: result.status ?? 1, said: result.stdout + result.stderr }; };
interface Finding { code: string; message: string }
const findingsOf = (): Finding[] => JSON.parse(spawnSync('node', [cli, 'check', '.', '--json'], { cwd: root, encoding: 'utf8' }).stdout);

try {
  pageWith('Custom Counter inputs(start: base, lable: "n=") on(dnoe: finish)');
  const findings = findingsOf();
  const typed = findings.filter((one) => one.code === 'custom-type');
  ok('an input its mount does not take is a finding at the call', typed.some((one) => one.message.includes('lable')), JSON.stringify(findings));
  ok('so is an event it does not take', typed.some((one) => one.message.includes('dnoe')), JSON.stringify(findings));
  pageWith('Custom Counter inputs(label: "n=") on(done: finish)');
  const missing = findingsOf();
  ok('a required input left out is a finding too', missing.some((one) => one.code === 'custom-type' && one.message.includes('start')), JSON.stringify(missing));
  pageWith('Custom Counter inputs(start: base, label: "n=") on(done: finish)');
  const right = findingsOf();
  ok('a call that matches its types checks clean', !right.some((one) => one.code === 'custom-type' || one.code === 'unknown-component'), JSON.stringify(right));
  const bundled = run(['bundle', '.']);
  ok('it bundles: the inlined one without its types, the one that imports through esbuild', bundled.code === 0, bundled.said);
  const assets = join(root, 'dist', 'assets');
  const code = readdirSync(assets).filter((file) => file.endsWith('.js')).map((file) => readFileSync(join(assets, file), 'utf8')).join('\n');
  ok('what ships is JavaScript: no type is left in it', !/\w: HTMLElement|: Inputs\b|interface Inputs|\): void\b|: number\b/.test(code), (code.match(/.{30}(?:\w: HTMLElement|: Inputs\b|interface Inputs|\): void\b|: number\b).{10}/) || [''])[0]);
  ok('both mounts are in the page', code.includes('textContent') && /\*\s*2|\*2/.test(code));
  const map = JSON.parse(spawnSync('node', [cli, 'map', '.', '--json'], { cwd: root, encoding: 'utf8' }).stdout);
  ok('muten map counts the app: .muten apart from JS/TS, the Customs apart', map.code?.muten.files === 2 && map.code?.script.files === 3 && map.code?.customs.files === 2 && map.code.mutenShare > 0 && map.code.mutenShare < 100, JSON.stringify(map.code));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
