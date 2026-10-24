#!/usr/bin/env node
// CLI entry point for the `muten` command.
// Commands: dev, bundle, build, check (lint), test, map, android. Delegates to runner.ts, build.ts, lint.ts, map.js
// and android.ts. Consumed by package.json "bin" -> `muten dev|bundle|build|check|map|lint|add|new|android [dir]`.
import { writeAppMap } from '../app-map-file.js';
import { resolve, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { dev, bundle } from '../runner.js';
import { buildApp } from '../build.js';
import { lintApp, lintWatch, findings } from '../lint.js';
import { fixApp } from '../fix.js';
import { doctorCommand } from '../doctor.js';
import { reportCommand } from '../report.js';
import { nativeCommand } from '../native-project.js';
import { fmtCommand } from '../fmt.js';
import { upgradeCommand } from '../upgrade.js';
import { configSchema } from '#engine/project/config-check.js';
import { helpText, COMMANDS } from '../cli-help.js';
import { explain, EXPLANATIONS } from '#engine/shared/explain/index.js';
import { addComponents } from '../add.js';
import { scaffoldNew } from '../scaffold.js';
import { androidCommand } from '../android.js';
import { testApp } from '../test-runner.js';
import { mapApp } from '#engine/project/map.js';
import { hasEnvironment } from '#engine/project/env.js';
import { ParseError, formatDiagnostic, diag, closest } from '#engine/shared/diagnostics.js';

const args = process.argv.slice(2);
const cmd = args[0];
const dir = args.slice(1).find((a) => !a.startsWith('-'));
const json = args.includes('--json');
const root = resolve(dir || process.cwd());
// the environment from muten.config `env { }` (engine/project/env.ts): --env=<name> or MUTEN_ENV, else `local` for the dev
// server and `prod` for what gets deployed. `check` and the editor read every environment's keys.
const envFlag = (args.find((a) => a.startsWith('--env=')) || '').slice(6);
const envDefault: { [command: string]: string } = { dev: 'local', test: 'local', bundle: 'prod', build: 'prod', android: 'prod' };
const chosenEnv = envFlag || process.env.MUTEN_ENV || envDefault[cmd] || '';

try {
  // inside the try: a muten.config that does not parse is reported at its line, not as a crash
  // dev with a muten.config that does not parse goes on: it serves the error and starts once the file is fixed (dev-wait.ts)
  const knownEnv = (name: string): boolean => { try { return hasEnvironment(root, name); } catch (e) { if (cmd === 'dev' && e instanceof ParseError) return false; throw e; } };
  if (chosenEnv && knownEnv(chosenEnv)) process.env.MUTEN_ENV = chosenEnv;
  else if (envFlag) { console.error(`✖ --env=${envFlag}: muten.config has no environment "${envFlag}" in env { }`); process.exit(1); }
  if (cmd === 'dev') await dev(root, args.includes('--host'));          // dev server; this machine only unless --host (wifi, a phone)
  else if (cmd === 'bundle') await bundle(root, args.includes('--sourcemap')); // production bundle; source maps only with --sourcemap
  else if (cmd === 'build') await buildApp(root, undefined, (args.find((a) => a.startsWith('--url=')) || '').slice(6)); // SSG → static HTML. --url=https://site.com → absolute sitemap/robots URLs
  else if (cmd === 'config' && args.includes('--schema')) console.log(JSON.stringify(configSchema(), null, 2));   // for the editor and an agent
  else if (cmd === 'upgrade') process.exitCode = (await upgradeCommand(root)) ? 0 : 1;   // installed vs published, and the line to run (upgrade.ts)
  else if (cmd === 'fmt') process.exitCode = fmtCommand(root, args.includes('--check')) ? 0 : 1;   // one shape for every file; only whitespace moves (fmt.ts)
  else if (cmd === 'doctor') process.exitCode = (await doctorCommand(root, json)) ? 0 : 1;   // everything the app needs, looked at once (doctor.ts)
  else if (cmd === 'native') { const ok = await nativeCommand(root, args); process.exitCode = process.exitCode || (ok ? 0 : 1); }   // the app as an Expo (React Native) app, a proof of concept (native-project.ts)
  else if (cmd === 'report') process.exitCode = (await reportCommand(root)) ? 0 : 1;   // what a bug report needs, written to .muten/report.md, sent nowhere (report.ts)
  else if (cmd === 'explain') {   // what a finding's code means, how to fix it, the slip next to its fix (explain/)
    const code = args[1] || '';
    const text = explain(code);
    if (json) console.log(JSON.stringify(EXPLANATIONS[code] ?? null));
    else if (text) console.log(text);
    else { console.error(`no code "${code}"${closest(code, Object.keys(EXPLANATIONS)) ? ` — did you mean "${closest(code, Object.keys(EXPLANATIONS))}"?` : ''}`); process.exitCode = 1; }
  }
  else if (cmd === 'check' || cmd === 'lint') {
    if (args.includes('--watch')) await lintWatch(root, json);          // standing oracle (CI/agents), no dev server
    else if (args.includes('--fix')) {   // the fixes it can be sure of, then what is left (fix.ts)
      const report = await fixApp(root);
      if (json) console.log(JSON.stringify({ applied: report.applied, left: report.left.map(({ found, why }) => ({ ...found, why })), remaining: await findings(root) }, null, 2));
      else {
        for (const one of report.applied) console.log(`  ✓ ${one.file}:${one.loc?.line}:${one.loc?.col}  ${one.fix?.from} → ${one.fix?.to}`);
        for (const { found, why } of report.left) console.log(`  · ${found.file}:${found.loc?.line}:${found.loc?.col}  ${found.fix?.from} → ${found.fix?.to} left: ${why}`);
        console.log(`${report.applied.length} fixed${report.left.length ? `, ${report.left.length} left for you` : ''}\n`);
        process.exitCode = (await lintApp(root, false)) ? 1 : 0;
      }
    }
    else if (args.includes('--native')) {   // what will not reach the phone (React Native), at its CSS line or node
      const { nativeLint } = await import('../native-lint.js');
      process.exitCode = (await lintApp(root, json)) ? 1 : 0;
      await nativeLint(root, json);
    }
    else process.exitCode = (await lintApp(root, json, args.includes('--changed'))) ? 1 : 0;   // not process.exit: piped, it cut stdout off at 64 kB (a big --json arrived broken)
  }
  else if (cmd === 'test') process.exit(await testApp(root, (args.find((a) => a.startsWith('--only=')) || '').slice(7)) ? 0 : 1);   // the .test files, in a headless browser, on mock data
  else if (cmd === 'map') {
    const map = await mapApp(root);
    if (json) console.log(JSON.stringify(map, null, 2));
    else {
      console.log(`✓ ${relative(root, writeAppMap(root, map))} → the app graph (read this first; stays on this machine)`);
      const code = map.code;
      if (code) console.log(`  code: ${code.muten.lines.toLocaleString('en')} lines of muten (${code.mutenShare}%) · ${code.script.lines.toLocaleString('en')} of JS/TS in ${code.script.files} files${code.customs.files ? `, ${code.customs.lines.toLocaleString('en')} of them in ${code.customs.files} Customs` : ''}`);
    }
  }
  // preflight the .apk toolchain (Capacitor+Gradle do the build; we say whether this machine can, and --install makes it so)
  else if (cmd === 'android') process.exit(await androidCommand(root, args) ? 0 : 1);
  else if (cmd === 'add') { // add a plugin (lowercase -> install + enable) or eject a registry component (PascalCase)
    const names = args.slice(1).filter((a) => !a.startsWith('-'));
    if (!names.length) { console.error('usage: muten add <name...>\n  lowercase  -> a plugin: install @muten/<name> + enable it in muten.config   (e.g. muten add devtools)\n  PascalCase -> a component: copy its source into src/parts/                      (e.g. muten add Button)'); process.exit(1); }
    await addComponents(process.cwd(), names);
  }
  else if (cmd === 'new') { // scaffold app STRUCTURE (routes entry + route lines + page/store skeletons) so you fill CONTENT, not boilerplate
    const cwd = process.cwd();   // `new` operates on the cwd (no [dir] arg — the rest are the names to scaffold)
    const kind = args[1];
    const names = args.slice(2).filter((a) => !a.startsWith('-'));
    if (!kind || (kind !== 'app' && !names.length)) { console.error('usage: muten new <page|store|app> <name...>\n  muten new page /  /dms  /settings   -> page skeleton + its route in src/app.muten (each COMPILES)\n  muten new store servers  channels    -> store skeleton (entity + empty list)\n  muten new app                        -> ensure src/app.muten (the routes entry) exists'); process.exit(1); }
    for (const f of scaffoldNew(cwd, kind, names)) console.log('✓ ' + relative(cwd, f));
  } else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(helpText());   // every command, one line each (cli-help.ts)
  else {
    console.error(`muten: no command "${cmd}"${closest(cmd, COMMANDS.map(([name]) => name.split(' ')[0])) ? ` — did you mean "${closest(cmd, COMMANDS.map(([name]) => name.split(' ')[0]))}"?` : ''}\n\n${helpText()}`);
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
