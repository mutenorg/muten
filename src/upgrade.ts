// upgrade: `muten upgrade`, the muten this app has against the one published, and the line that moves it. It installs
// nothing (that is the app's package manager's call: npm here, yarn there). When a version renames something in the
// language, its rewrite goes here; none has yet (`use react` still reads, `use` alone is new, not a replacement).

import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org/@muten/core/latest';
const PACKAGE = '@muten/core';

const versionAt = (file: string): string => { try { const pkg: unknown = JSON.parse(readFileSync(file, 'utf8')); return pkg && typeof pkg === 'object' && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : ''; } catch { return ''; } };
const newer = (a: string, b: string): boolean => { const [x, y] = [a, b].map((v) => v.split('.').map(Number)); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

/** `muten upgrade`: says where the app stands and what to run. True when it is up to date. */
export async function upgradeCommand(root: string): Promise<boolean> {
  const installed = join(root, 'node_modules', '@muten', 'core');
  if (existsSync(installed) && lstatSync(installed).isSymbolicLink()) { console.log('  this app uses the workspace engine by path: it is as new as that checkout'); return true; }
  const have = versionAt(join(installed, 'package.json'));
  let latest = '';
  try { const answer: unknown = await (await fetch(REGISTRY)).json(); if (answer && typeof answer === 'object' && 'version' in answer && typeof answer.version === 'string') latest = answer.version; } catch { latest = ''; }
  if (!latest) { console.log(`  ${PACKAGE} ${have || 'not installed'} · the registry did not answer (offline?)`); return Boolean(have); }
  if (have && !newer(latest, have)) { console.log(`  ✓ ${PACKAGE} ${have}, the latest`); return true; }
  const manager = existsSync(join(root, 'yarn.lock')) ? `yarn add ${PACKAGE}@${latest}` : `npm i ${PACKAGE}@${latest}`;
  console.log(`  ${PACKAGE} ${have || 'not installed'} → ${latest}\n  run: ${manager}\n  then: muten check (a new version may find what the old one did not)`);
  return false;
}
