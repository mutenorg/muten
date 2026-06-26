#!/usr/bin/env node
// CLI entry point for the `muten` command.
// Commands: build, check (lint), map. Delegates to build.ts, lint.ts, and map.js.
// Consumed by package.json "bin" -> users run `muten build|check|map|lint [dir] [--json]`.
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { buildApp } from '../build.js';
import { lintApp } from '../lint.js';
import { mapApp } from '#engine/project/map.js';

const args = process.argv.slice(2);
const cmd = args[0];
const dir = args.slice(1).find((a) => !a.startsWith('-'));
const json = args.includes('--json');
const root = resolve(dir || process.cwd());

try {
  if (cmd === 'build') await buildApp(root, undefined, (args.find((a) => a.startsWith('--url=')) || '').slice(6)); // --url=https://site.com → absolute sitemap/robots URLs
  else if (cmd === 'check' || cmd === 'lint') process.exit((await lintApp(root, json)) ? 1 : 0);
  else if (cmd === 'map') {
    const map = await mapApp(root);
    if (json) console.log(JSON.stringify(map, null, 2));
    else { writeFileSync(join(root, 'app.map.json'), JSON.stringify(map, null, 2)); console.log('✓ app.map.json → the app graph (read this first)'); }
  } else {
    console.error('usage: muten <build|check|map|lint> [dir] [--json]\nto create an app:  npm create muten@latest <dir>');
    process.exit(1);
  }
} catch (e) {
  console.error('✖ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
