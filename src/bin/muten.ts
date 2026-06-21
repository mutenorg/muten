#!/usr/bin/env node
// CLI:  muten <build|lint> [app-dir]   (default app-dir: the current directory)
// Installed as a package, you run it inside your app and it compiles the cwd.

import { resolve } from 'node:path';
import { buildApp } from '../build.js';
import { lintApp } from '../lint.js';

const [cmd, dir] = process.argv.slice(2);

try {
  if (cmd === 'build') await buildApp(resolve(dir || process.cwd()));               // compile → dist/
  else if (cmd === 'lint') process.exit((await lintApp(resolve(dir || process.cwd()))) ? 1 : 0);
  else { console.error('usage: muten <build|lint> [dir]   (default: the current directory)\nto create an app:  npm create muten@latest <dir>'); process.exit(1); }
} catch (e) {
  console.error('✖ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
