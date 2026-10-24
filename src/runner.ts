// runner.ts: `muten dev` / `muten bundle` — the native runner (embedded esbuild). muten owns the entry AND the
// bundler (see esbuild-muten.ts): a muten app needs no vite.config, no bundler config — the build config is
// muten.config, and the only .js/.ts left are the escapes. This file just reads the port and delegates.

import { bundleEsbuild } from './esbuild-muten.js';
import { devEsbuild, type DevOptions } from './dev-server.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMutenConfig, type ConfigBlock } from '#engine/project/config.js';
import { ParseError } from '#engine/shared/diagnostics.js';
import { hostRuleProblem } from './dev-security.js';

// the dev server's reach from muten.config `dev { port  host  hosts }` and the CLI's `--host`:
//   port  — 0/undefined -> the engine's default (5173)
//   host  — "lan" (or `--host`) opens it to the wifi (a phone, Capacitor live reload); default: this machine only
//   hosts — domain names allowed to reach it besides localhost (a tunnel: ["dev.storio.ink"], ".example.com" for a whole zone)
// a muten.config that does not parse still says its port: read it from the text, so the page that shows the error (and
// waits for the fix, dev-wait.ts) is where the app will be, instead of the process ending before it serves anything
const PORT_IN_TEXT = /\bport\s+(\d{2,5})\b/;

function readDevBlock(root: string): { port?: number; config: ConfigBlock } {
  try {
    const dev = readMutenConfig(root).dev ?? {};
    return { config: typeof dev === 'object' && !Array.isArray(dev) ? dev : {} };
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    const file = join(root, 'muten.config');
    const port = existsSync(file) ? Number(PORT_IN_TEXT.exec(readFileSync(file, 'utf8'))?.[1] || 0) : 0;
    return { port: port || undefined, config: {} };   // devEsbuild meets the same error and serves it until it is fixed
  }
}

function devOptions(root: string, lan: boolean): DevOptions {
  const { port: textPort, config } = readDevBlock(root);
  const port = typeof config.port === 'number' ? config.port : textPort ?? 0;
  const hostLan = lan || config.host === 'lan' || config.host === '0.0.0.0';
  const hosts = Array.isArray(config.hosts) ? config.hosts.filter((h): h is string => typeof h === 'string') : [];
  const envHosts = (process.env.MUTEN_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  // a rule that would let a domain the app does not own reach the dev server stops the start, it is not skipped quietly
  const bad = [...hosts, ...envHosts].map((rule) => ({ rule, why: hostRuleProblem(rule) })).filter((x) => x.why);
  if (bad.length) {
    for (const { rule, why } of bad) console.error(`✖ muten.config dev { hosts }: "${rule}" ${why}`);
    process.exit(1);
  }
  return { port: port || 5173, lan: hostLan, hosts: [...hosts, ...envHosts] };
}

export async function dev(root: string, lan = false): Promise<void> {
  await devEsbuild(root, devOptions(root, lan));
}

export async function bundle(root: string, sourcemap = false): Promise<void> {
  const { outDir } = await bundleEsbuild(root, undefined, { sourcemap });
  console.log(`✓ bundled (esbuild) → ${outDir}`);
}
