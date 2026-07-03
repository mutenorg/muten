#!/usr/bin/env node
// CLI entry point for the `muten` command.
// Commands: dev, bundle, build, check (lint), map. Delegates to runner.ts, build.ts, lint.ts, and map.js.
// Consumed by package.json "bin" -> users run `muten dev|bundle|build|check|map|lint [dir] [--json]`.
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { dev, bundle } from '../runner.js';
import { buildApp } from '../build.js';
import { lintApp, lintWatch } from '../lint.js';
import { addComponents } from '../add.js';
import { mapApp } from '#engine/project/map.js';

const args = process.argv.slice(2);
const cmd = args[0];
const dir = args.slice(1).find((a) => !a.startsWith('-'));
const json = args.includes('--json');
const root = resolve(dir || process.cwd());

try {
  if (cmd === 'dev') await dev(root, !args.includes('--vite')); // native esbuild dev server by default; --vite for the legacy engine
  else if (cmd === 'bundle') await bundle(root, !args.includes('--vite')); // native esbuild production bundle; --vite for the legacy engine
  else if (cmd === 'build') await buildApp(root, undefined, (args.find((a) => a.startsWith('--url=')) || '').slice(6)); // SSG → static HTML. --url=https://site.com → absolute sitemap/robots URLs
  else if (cmd === 'check' || cmd === 'lint') {
    if (args.includes('--watch')) await lintWatch(root, json);          // standing oracle (CI/agents), no dev server
    else process.exit((await lintApp(root, json)) ? 1 : 0);
  }
  else if (cmd === 'map') {
    const map = await mapApp(root);
    if (json) console.log(JSON.stringify(map, null, 2));
    else { writeFileSync(join(root, 'app.map.json'), JSON.stringify(map, null, 2)); console.log('✓ app.map.json → the app graph (read this first)'); }
  }
  else if (cmd === 'add') { // add a plugin (lowercase -> install + enable) or eject a registry component (PascalCase)
    const names = args.slice(1).filter((a) => !a.startsWith('-'));
    if (!names.length) { console.error('usage: muten add <name...>\n  lowercase  -> a plugin: install @muten/<name> + enable it in muten.config   (e.g. muten add devtools)\n  PascalCase -> a component: copy its source into src/parts/                      (e.g. muten add Button)'); process.exit(1); }
    addComponents(process.cwd(), names);
  } else {
    console.error('usage: muten <dev|bundle|build|check|map|lint|add> [dir] [--json]\nto create an app:  npm create muten@latest <dir>');
    process.exit(1);
  }
} catch (e) {
  console.error('✖ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
