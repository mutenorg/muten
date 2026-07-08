#!/usr/bin/env node
// CLI entry point for the `muten` command.
// Commands: dev, bundle, build, check (lint), map. Delegates to runner.ts, build.ts, lint.ts, and map.js.
// Consumed by package.json "bin" -> users run `muten dev|bundle|build|check|map|lint [dir] [--json]`.
import { resolve, join, relative } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { dev, bundle } from '../runner.js';
import { buildApp } from '../build.js';
import { lintApp, lintWatch } from '../lint.js';
import { addComponents } from '../add.js';
import { scaffoldNew } from '../scaffold.js';
import { mapApp } from '#engine/project/map.js';
import { ParseError, formatDiagnostic, diag } from '#engine/shared/diagnostics.js';

const args = process.argv.slice(2);
const cmd = args[0];
const dir = args.slice(1).find((a) => !a.startsWith('-'));
const json = args.includes('--json');
const root = resolve(dir || process.cwd());

try {
  if (cmd === 'dev') await dev(root);          // native esbuild dev server (surgical HMR + oracle overlay)
  else if (cmd === 'bundle') await bundle(root); // native esbuild production bundle (per-route chunks + source maps)
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
  }
  else if (cmd === 'new') { // scaffold app STRUCTURE (routes entry + route lines + page/store skeletons) so you fill CONTENT, not boilerplate
    const cwd = process.cwd();   // `new` operates on the cwd (no [dir] arg — the rest are the names to scaffold)
    const kind = args[1];
    const names = args.slice(2).filter((a) => !a.startsWith('-'));
    if (!kind || (kind !== 'app' && !names.length)) { console.error('usage: muten new <page|store|app> <name...>\n  muten new page /  /dms  /settings   -> page skeleton + its route in src/app.muten (each COMPILES)\n  muten new store servers  channels    -> store skeleton (entity + empty list)\n  muten new app                        -> ensure src/app.muten (the routes entry) exists'); process.exit(1); }
    for (const f of scaffoldNew(cwd, kind, names)) console.log('✓ ' + relative(cwd, f));
  } else {
    console.error('usage: muten <dev|bundle|build|check|map|lint|add|new> [dir] [--json]\nto create an app:  npm create muten@latest <dir>');
    process.exit(1);
  }
} catch (e) {
  // a syntax error that escaped validate (a bad .store/part/app.muten) still prints file:line:col + the hint,
  // never a bare locationless message — that's what left the model regenerating identical output in a loop.
  if (e instanceof ParseError) {
    let src: string | undefined; try { if (e.file) src = readFileSync(e.file, 'utf8'); } catch { /* no frame if unreadable */ }
    console.error(formatDiagnostic(diag(e.code, e.message, { loc: e.loc }), e.file ? relative(root, e.file) : 'src', src));
  }
  else console.error('✖ ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
}
