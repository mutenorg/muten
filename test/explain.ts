// `muten explain <code>`: every code a finding can carry has its explanation. The codes are read from the source (each
// `diag('code', …)`, each `error.code = 'code'`, each exported code constant), so a new finding without one fails here.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXPLANATIONS, explain } from '../dist/engine/shared/explain/index.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const src = new URL('../src/', import.meta.url).pathname;
const files = []; const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.ts')) files.push(p); } }; walk(src);
const codes = new Set();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/diag\('([a-z][a-z0-9-]+)'/g)) codes.add(m[1]);
  for (const m of text.matchAll(/\.code = '([a-z][a-z0-9-]+)'/g)) codes.add(m[1]);
  for (const m of text.matchAll(/\bcode: (?:[^'\n]*\? )?'([a-z][a-z0-9-]+)'(?: : '([a-z][a-z0-9-]+)')?/g)) { codes.add(m[1]); if (m[2]) codes.add(m[2]); }   // { code: 'package-type', … } and a choice of two
  for (const m of text.matchAll(/export const UNKNOWN_[A-Z_]+ = '([a-z][a-z0-9-]+)'/g)) codes.add(m[1]);
}
const missing = [...codes].filter((code) => !EXPLANATIONS[code]);
ok(`every code a finding can carry is explained (${codes.size} codes)`, missing.length === 0, missing.join(', '));
ok('each explanation says what it means and how to fix it', Object.values(EXPLANATIONS).every((entry) => entry.means && entry.fix));
ok('explain prints the meaning, the fix and the example', /means|argument/.test(explain('unknown-arg') || '') && (explain('unknown-arg') || '').includes('✓ Topbar(paused: no)'));
ok('an unknown code has no explanation', explain('no-such-code') === null);
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
