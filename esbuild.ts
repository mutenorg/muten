// Build: every src/**/*.ts → dist/**/*.js, MINIFIED, per-file (the module graph is preserved and the
// #engine/* imports stay intact, so package.json "imports" resolves them — no monolithic bundle that
// would bloat large apps). Type-checking is a separate `tsc` pass (see `npm run build`).
// Run via node's type stripping (it is the build bootstrap, so it can't compile itself): see package.json.
import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const collect = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
};

await build({
  entryPoints: collect('src'),
  outdir: 'dist',
  outbase: 'src',
  format: 'esm',
  target: 'es2022',
  bundle: false,   // per-file: keep modules + #engine imports (resolved at runtime by package.json "imports")
  minify: true,
});
// The same runtime as ONE script, for the outputs with no bundler (the standalone HTML page, the build-time pre-render):
// they used to carry a hand-written copy of the signals core that had drifted from runtime.ts (no `untrack` for
// actions, no `__id`, eager gets). Now there is one core, built twice.
await build({
  entryPoints: ['src/runtime.ts'],
  outfile: 'dist/runtime-inline.js',
  bundle: true,
  format: 'iife',
  globalName: '__mutenRt',
  target: 'es2022',
  define: { __MUTEN_DEV__: 'false' },
  minify: true,
});
console.log('✓ dist/ built (minified, per-file ESM)');
