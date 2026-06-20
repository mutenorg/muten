#!/usr/bin/env node
// CLI:  muten <build|lint> [app-dir]   (default app-dir: current directory)
// When installed as a package, you run it inside your app → it compiles the cwd.
import { resolve } from 'node:path';
import { buildApp } from '../build.js';
import { lintApp } from '../lint.js';

const [cmd, dir] = process.argv.slice(2);
const appRoot = resolve(dir || process.cwd());

try {
  if (cmd === 'build') await buildApp(appRoot);
  else if (cmd === 'lint') process.exit((await lintApp(appRoot)) ? 1 : 0);
  else { console.error('usage: muten <build|lint> [app-dir]   (default: current directory)'); process.exit(1); }
} catch (e) {
  console.error('✖ ' + e.message);
  process.exit(1);
}
