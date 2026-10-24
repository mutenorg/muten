// report: `muten report` writes what a bug report needs, to .muten/report.md, and sends nothing. When muten itself
// breaks (the dev overlay says «this looks like a muten bug»), the person reporting it should not have to know what
// matters: the muten and Node versions, the system, the app's packages, which muten.config blocks and keys it uses
// (never their values: they hold keys and addresses), what `check` finds, and the last runtime error the overlay showed
// (dev-server.ts keeps it in .muten/last-error.txt). They read the file, and paste it where they choose.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { arch, platform, release } from 'node:os';
import { readMutenConfig } from '#engine/project/config.js';
import { findings } from './lint.js';

const ENGINE = new URL('../package.json', import.meta.url);
const SHOWN_FINDINGS = 12;
/** Where `muten dev` keeps the last runtime error its overlay showed (read by the report). */
export const LAST_ERROR = join('.muten', 'last-error.txt');

interface Manifest { version?: string; dependencies?: { [name: string]: string }; devDependencies?: { [name: string]: string } }
const manifestOf = (file: string | URL): Manifest => { try { const parsed: Manifest = JSON.parse(readFileSync(file, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } };

/** The report's text. */
export async function reportText(root: string): Promise<string> {
  const engine = manifestOf(ENGINE).version ?? '?';
  const app = manifestOf(join(root, 'package.json'));
  const packages = Object.entries({ ...app.devDependencies, ...app.dependencies }).sort(([a], [b]) => a.localeCompare(b));
  const installed = manifestOf(join(root, 'node_modules', '@muten', 'core', 'package.json')).version;
  let config = '';
  try { config = Object.entries(readMutenConfig(root)).map(([block, body]) => `- \`${block}\`: ${Object.keys(body).join(', ') || '(empty)'}`).join('\n'); }
  catch (error) { config = `- does not parse: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`; }
  let found: string;
  try {
    const all = await findings(root);
    const errors = all.filter((one) => one.severity === 'error').length;
    found = `${errors} error(s), ${all.length - errors} warning(s)` + (all.length ? '\n\n' + all.slice(0, SHOWN_FINDINGS).map((one) => `- ${one.severity} \`${one.code}\` ${one.file}${one.loc ? `:${one.loc.line}:${one.loc.col}` : ''}: ${one.message.split('\n')[0]}`).join('\n') + (all.length > SHOWN_FINDINGS ? `\n- … and ${all.length - SHOWN_FINDINGS} more` : '') : '');
  } catch (error) { found = `check itself failed: ${error instanceof Error ? error.stack || error.message : String(error)}`; }
  const lastFile = join(root, LAST_ERROR);
  const last = existsSync(lastFile) ? `Seen ${statSync(lastFile).mtime.toISOString()}:\n\n\`\`\`\n${readFileSync(lastFile, 'utf8').trim()}\n\`\`\`` : 'None recorded (`muten dev` keeps the last one its overlay shows).';
  return `# muten report

- muten: ${engine} (running)${installed && installed !== engine ? `, ${installed} installed in the app` : ''}
- Node: ${process.versions.node}
- System: ${platform()} ${release()} ${arch()}

## The app's packages

${packages.length ? packages.map(([name, version]) => `- ${name} ${version}`).join('\n') : '- none'}

## muten.config (blocks and keys, no values)

${config || '- none'}

## muten check

${found}

## Last runtime error

${last}
`;
}

/** `muten report`: writes .muten/report.md and says where. */
export async function reportCommand(root: string): Promise<boolean> {
  const text = await reportText(root);
  mkdirSync(join(root, '.muten'), { recursive: true });
  const file = join(root, '.muten', 'report.md');
  writeFileSync(file, text);
  console.log(`✓ ${relative(process.cwd(), file) || file} → what a bug report needs. Nothing was sent: read it, then paste it where you report the bug.`);
  console.log('  It holds the versions, the app\'s packages, muten.config\'s block and key names (no values), what check finds and the last runtime error.');
  return true;
}
