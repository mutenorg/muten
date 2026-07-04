// runner.ts: `muten dev` / `muten bundle` — the native runner (embedded esbuild). muten owns the entry AND the
// bundler (see esbuild-muten.ts): a muten app needs no vite.config, no bundler config — the build config is
// muten.config, and the only .js/.ts left are the escapes. This file just reads the port and delegates.

import { bundleEsbuild, devEsbuild } from './esbuild-muten.js';
import { readMutenConfig } from '#engine/project/config.js';

// the dev server port from muten.config `dev { port }` (0/undefined -> the engine's default).
function devPort(root: string): number {
  const dev = readMutenConfig(root).dev ?? {};
  return typeof dev.port === 'number' ? dev.port : 0;
}

export async function dev(root: string): Promise<void> {
  await devEsbuild(root, devPort(root) || 5173);
}

export async function bundle(root: string): Promise<void> {
  const { outDir } = await bundleEsbuild(root);
  console.log(`✓ bundled (esbuild) → ${outDir}`);
}
