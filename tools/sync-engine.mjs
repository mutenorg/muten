// Copies the PURE subset of the engine (no node:fs at parse time) into the extension,
// so live-lint can run parse+validate over the editor text in real time.
// Run after touching the engine:  node tools/sync-engine.mjs
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const eng = join(here, '..', 'engine');
const dst = join(here, 'muten-vscode', 'engine');

mkdirSync(dst, { recursive: true });
for (const f of ['parse.js', 'flatten.js', 'validate.js', 'diagnostics.js', 'manifest.js', 'theme.js', 'compose.js', 'analyze.js']) {
  copyFileSync(join(eng, f), join(dst, f));
}
// mark the folder as ESM (the extension is CJS; these files use import/export)
writeFileSync(join(dst, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log('✓ engine synced into muten-vscode/engine/');
