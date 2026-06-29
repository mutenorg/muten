// runner.ts: `muten dev` / `muten bundle` — run Vite as a LIBRARY with the muten (+ tailwind) plugins wired,
// so a muten app needs no vite.config. The build config is muten.config; the only .js/.ts left are the escapes.
// Vite and @tailwindcss/vite come from the APP's own node_modules (resolved against its package.json), so this
// stays a thin orchestrator — muten owns the entry, the bundler is a subroutine. ponytail: thin wrapper over
// Vite's JS API; swap Vite for esbuild/Bun here when the runner goes native (RUNNER.md), the CLI surface holds.

import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import muten from './vite-plugin-muten.js';
import { bundleEsbuild, devEsbuild } from './esbuild-muten.js';
import { readMutenConfig } from '#engine/project/config.js';

interface ViteServer { listen(): Promise<unknown>; printUrls(): void; }
interface Vite { createServer(config: object): Promise<ViteServer>; build(config: object): Promise<unknown>; }

// the dev server port from muten.config `dev { port }` (0/undefined -> the engine's default).
function devPort(root: string): number {
  const dev = readMutenConfig(root).dev ?? {};
  return typeof dev.port === 'number' ? dev.port : 0;
}

// inline Vite config from muten.config: the muten plugin + (if installed) tailwind, plus `dev { port }`.
function inlineConfig(root: string, req: NodeRequire): object {
  const plugins: object[] = [muten()];
  try { const tw = req('@tailwindcss/vite'); plugins.push((tw.default ?? tw)()); } catch { /* app doesn't use tailwind */ }
  const port = devPort(root);
  return { root, plugins, ...(port ? { server: { port } } : {}) };
}

// Vite is the app's, not ours — resolve it against the app so we don't carry it as a dependency.
async function loadVite(root: string): Promise<{ vite: Vite; req: NodeRequire }> {
  const req = createRequire(join(root, 'package.json'));
  const vite: Vite = await import(pathToFileURL(req.resolve('vite')).href);
  return { vite, req };
}

export async function dev(root: string, esbuildEngine = false): Promise<void> {
  if (esbuildEngine) { await devEsbuild(root, devPort(root) || 5173); return; }
  const { vite, req } = await loadVite(root);
  const server = await vite.createServer(inlineConfig(root, req));
  await server.listen();
  server.printUrls();
}

export async function bundle(root: string, esbuildEngine = false): Promise<void> {
  if (esbuildEngine) { const { outDir } = await bundleEsbuild(root); console.log(`✓ bundled (esbuild) → ${outDir}`); return; }
  const { vite, req } = await loadVite(root);
  await vite.build(inlineConfig(root, req));
}
