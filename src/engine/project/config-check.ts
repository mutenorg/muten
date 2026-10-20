// config-check: what `muten check` (and the editor) says about muten.config. Nothing read it but the commands that
// used it: a syntax error crashed `bundle` with the engine's minified code, and a misspelled block or key (`plugns`,
// `security { cps … }`, `css { purne … }`) did nothing, so a CSP or a CSS setting you thought was on was not.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, type ConfigValue, type ConfigLocs } from '#engine/project/config.js';
import { packageDir } from '#engine/project/theme-library.js';
import { ParseError, closest, diag } from '#engine/shared/diagnostics.js';
import type { Diagnostic } from '#engine/shared/types.js';

type Kind = 'text' | 'number' | 'bool' | 'list' | 'block';
interface KeyRule { kinds: Kind[]; values?: string[]; doc: string }
// every block muten reads, and what each of its keys holds. `plugins` and `env` are open: their keys are names you choose.
const SCHEMA: { readonly [block: string]: { readonly [key: string]: KeyRule } } = {
  dev: {
    port: { kinds: ['number'], doc: 'the dev server port (5173 by default)' },
    host: { kinds: ['text'], values: ['lan', '0.0.0.0'], doc: '"lan" opens the dev server to the wifi' },
    hosts: { kinds: ['list'], doc: 'domain names allowed to reach the dev server, like ["dev.example.com"]' },
  },
  security: {
    csp: { kinds: ['text', 'bool'], doc: '"default", "off", or your own Content-Security-Policy' },
    frame: { kinds: ['text'], values: ['self', 'deny', 'any'], doc: 'who may put the app in an iframe' },
    headers: { kinds: ['text', 'bool'], values: ['off'], doc: '"off" writes no _headers file' },
  },
  css: { prune: { kinds: ['bool'], doc: 'false keeps every CSS rule, even ones no page can match' } },
  styling: {
    prefix: { kinds: ['block'], doc: 'how theme sections map to the CSS library\'s variables' },
    blocks: { kinds: ['block'], doc: 'the CSS blocks the theme is written into' },
    classes: { kinds: ['block'], doc: 'the classes a Form part gets' },
  },
};
const OPEN_BLOCKS = ['plugins', 'env'];
const BLOCKS = [...Object.keys(SCHEMA), ...OPEN_BLOCKS];

const kindOf = (value: ConfigValue): Kind => (typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : Array.isArray(value) ? 'list' : 'block');

/** The diagnostics of muten.config, from its text (the editor checks it as it is typed). */
export function checkConfigText(appRoot: string, text: string): Diagnostic[] {
  const locs: ConfigLocs = {};
  let config;
  try { config = parseConfig(text, locs); }
  catch (e) {
    if (e instanceof ParseError) return [{ code: 'syntax', severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
    throw e;
  }
  const out: Diagnostic[] = [];
  for (const [block, body] of Object.entries(config)) {
    const loc = locs[block] ?? null;
    if (!BLOCKS.includes(block)) { out.push(diag('config-block', `muten.config has no block "${block}" (it has: ${BLOCKS.join(', ')}). It is ignored.`, { loc, suggestion: closest(block, BLOCKS), from: block })); continue; }
    if (block === 'plugins') {
      for (const name of Object.keys(body))
        if (!packageDir(appRoot, `@muten/${name}`) && !packageDir(appRoot, name)) out.push(diag('plugin-missing', `the plugin "${name}" is not installed, so this line does nothing: \`muten add ${name}\` (or \`npm i @muten/${name}\`), or remove it.`, { loc: locs[`plugins.${name}`] ?? loc, from: name, severity: 'warning' }));
      continue;
    }
    if (block === 'env') {
      for (const [name, values] of Object.entries(body)) {
        if (kindOf(values) !== 'block') { out.push(diag('config-value', `env.${name} is an environment: a block of values, like \`${name} { api "https://…" }\`.`, { loc: locs[`env.${name}`] ?? loc })); continue; }
        if (typeof values === 'object' && !Array.isArray(values)) for (const [key, value] of Object.entries(values))
          if (kindOf(value) === 'block' || kindOf(value) === 'list') out.push(diag('config-value', `env.${name}.${key}: an environment value is a "text", a number or true/false (it reaches the page as \`env.${key}\`).`, { loc: locs[`env.${name}.${key}`] ?? loc }));
      }
      continue;
    }
    const rules = SCHEMA[block];
    for (const [key, value] of Object.entries(body)) {
      const at = locs[`${block}.${key}`] ?? loc;
      const rule = rules[key];
      if (!rule) { out.push(diag('config-key', `${block} has no setting "${key}" (it has: ${Object.keys(rules).join(', ')}). It is ignored.`, { loc: at, suggestion: closest(key, Object.keys(rules)), from: key })); continue; }
      const kind = kindOf(value);
      if (!rule.kinds.includes(kind)) { out.push(diag('config-value', `${block}.${key} is ${rule.doc}, not a ${kind}.`, { loc: at })); continue; }
      if (rule.values && typeof value === 'string' && !rule.values.includes(value) && !(block === 'security' && key === 'csp'))
        out.push(diag('config-value', `${block}.${key} is one of ${rule.values.map((v) => `"${v}"`).join(', ')}, not "${value}".`, { loc: at, suggestion: closest(value, rule.values), from: value }));
      if (block === 'security' && key === 'csp' && typeof value === 'string' && !['default', 'off'].includes(value) && !/-src\b/.test(value))
        out.push(diag('config-value', `security.csp is "default", "off" or a policy like "default-src 'self'; script-src 'self'"; "${value}" is none of them, so the page would ship with no policy.`, { loc: at, suggestion: closest(value, ['default', 'off']), from: value }));
    }
  }
  return out;
}

/** The diagnostics of the app's muten.config (none when it has none). */
export function checkConfig(appRoot: string): Diagnostic[] {
  const file = join(appRoot, 'muten.config');
  return existsSync(file) ? checkConfigText(appRoot, readFileSync(file, 'utf8')) : [];
}
