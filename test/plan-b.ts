// `muten android --plan-b` (compose-probe.ts): every node of an app sorted by what compiling it to a native UI would
// take (direct, work, or web only), and the nodes styled by CSS classes, counted with their classes.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeProbe } from '../dist/compose-probe.js';

let fails = 0;
const ok = (label: string, cond: boolean, extra = ''): void => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };

const root = mkdtempSync(join(tmpdir(), 'muten-plan-b-'));
const write = (path: string, text: string): void => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
try {
  write('src/app.muten', 'routes {\n  "/" -> home\n}\n');
  write('src/components/Map.js', 'function mount(el) {}\n');
  write('src/pages/home/home.muten', 'screen home\nuse fmt from "~/lib/fmt.ts"\nstate { n = 1 : number }\nPage {\n  Stack class("card wide") {\n    Text "{n}"\n    Text "{fmt(n)}"\n    Svg { Circle cx(5) cy(5) r(4) }\n    Custom Map\n  }\n}\n');
  write('src/lib/fmt.ts', 'export const fmt = (n: number): string => String(n);\n');
  const probe = await composeProbe(root);
  ok('a Custom and a call into JS stay web, an SVG is work, the rest is direct', probe.webOnly === 2 && probe.work === 2 && probe.direct === probe.nodes - 4, JSON.stringify(probe));
  ok('the nodes styled by CSS are counted, with their classes', probe.styled === 1 && probe.classes === 2, JSON.stringify(probe));
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
