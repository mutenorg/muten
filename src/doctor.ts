// doctor: `muten doctor`, everything an app needs, looked at once: the Node it runs on, which muten it gets (the one
// published, or the workspace's by path), its entry, its muten.config, what `check` finds, the port `dev` will take,
// Chrome (for `muten test` and prerender) and, when the app has an Android project, the JDK and SDK. A list of what is
// fine and, for what is not, how to fix it. Nothing is changed.

import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { checkConfig } from '#engine/project/config-check.js';
import { readMutenConfig } from '#engine/project/config.js';
import { findChrome } from './headless.js';
import { androidRequirements } from './android.js';
import { findings } from './lint.js';
import type { Requirement } from './android.js';

const NODE_MIN = 22;   // `node --experimental-strip-types` (an app's own scripts, muten's tests) needs 22.6+
const DEV_PORT = 5173;
const ENGINE = new URL('../package.json', import.meta.url);

const versionOf = (file: string | URL): string => { try { const pkg: unknown = JSON.parse(readFileSync(file, 'utf8')); return pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : '?'; } catch { return '?'; } };

/** Whether `port` is free on this machine (dev would take another, and the app's links to it would break). */
function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

/** Every check, judged. */
export async function diagnose(root: string): Promise<Requirement[]> {
  const out: Requirement[] = [];
  const node = Number(process.versions.node.split('.')[0]);
  out.push({ name: 'Node', ok: node >= NODE_MIN, found: process.versions.node, fix: node >= NODE_MIN ? [] : [`Install Node ${NODE_MIN} or newer (https://nodejs.org)`] });

  const installed = join(root, 'node_modules', '@muten', 'core');
  const linked = existsSync(installed) && lstatSync(installed).isSymbolicLink();
  const engine = versionOf(ENGINE);
  const appEngine = existsSync(installed) ? versionOf(join(installed, 'package.json')) : '';
  out.push({ name: 'muten', ok: Boolean(appEngine), found: appEngine ? `${appEngine}${linked ? ' (the workspace engine, by path)' : ''} · this CLI ${engine}` : 'not installed in this app', fix: appEngine ? [] : ['npm i @muten/core'] });

  const entry = join(root, 'src', 'app.muten');
  const html = existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '';
  const entryOk = existsSync(entry) && html.includes('/src/app.muten');
  out.push({ name: 'entry', ok: entryOk, found: existsSync(entry) ? (html.includes('/src/app.muten') ? 'index.html loads src/app.muten' : 'index.html does not load /src/app.muten') : 'no src/app.muten', fix: entryOk ? [] : existsSync(entry) ? ['index.html: <script type="module" src="/src/app.muten"></script>'] : ['muten new app'] });

  const config = checkConfig(root).filter((d) => d.severity === 'error');
  out.push({ name: 'muten.config', ok: !config.length, found: config.length ? `${config.length} problem(s): ${config[0].message}` : 'fine', fix: config.length ? ['muten check (it says each one, at its line)'] : [] });

  const found = await findings(root);
  const errors = found.filter((d) => d.severity === 'error').length;
  out.push({ name: 'check', ok: !errors, found: `${errors} error(s), ${found.length - errors} warning(s)`, fix: errors ? ['muten check --fix (the sure ones), then muten check'] : [] });

  const dev = readMutenConfig(root).dev;
  const port = dev && typeof dev === 'object' && !Array.isArray(dev) && typeof dev.port === 'number' ? dev.port : DEV_PORT;
  const free = await portFree(port);
  // taken is not wrong: it is usually this app's own `muten dev`, running. Said, so a stranger on it is noticed
  out.push({ name: 'dev port', ok: true, found: free ? `${port} is free` : `${port} is in use: this app's muten dev, or something else (then dev takes another port and links to it break)`, fix: [] });

  const chrome = findChrome();
  out.push({ name: 'Chrome', ok: Boolean(chrome), found: chrome ?? 'not found (muten test and prerender need it)', fix: chrome ? [] : ['install Google Chrome or Chromium, or set CHROME_PATH'] });

  if (existsSync(join(root, 'android')) || existsSync(join(root, 'capacitor.config.json')) || existsSync(join(root, 'capacitor.config.ts'))) out.push(...androidRequirements(root));
  return out;
}

/** `muten doctor`: prints the list; true when everything is fine. */
export async function doctorCommand(root: string, json: boolean): Promise<boolean> {
  const checks = await diagnose(root);
  if (json) { console.log(JSON.stringify(checks, null, 2)); return checks.every((check) => check.ok); }
  for (const check of checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.name.padEnd(13)} ${check.found}`);
    for (const fix of check.fix) console.log(`  ${' '.repeat(16)}→ ${fix}`);
  }
  const bad = checks.filter((check) => !check.ok).length;
  console.log(bad ? `\n${bad} thing(s) to fix` : '\nall good');
  return bad === 0;
}
