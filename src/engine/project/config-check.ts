// config-check: what `muten check` (and the editor) says about muten.config. Nothing read it but the commands that
// used it: a syntax error crashed `bundle` with the engine's minified code, and a misspelled block or key (`plugns`,
// `security { cps … }`, `css { purne … }`) did nothing, so a CSP or a CSS setting you thought was on was not.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, type ConfigValue, type ConfigLocs } from '#engine/project/config.js';
import { packageDir } from '#engine/project/theme-library.js';
import { ParseError, closest, diag } from '#engine/shared/diagnostics.js';
import type { Diagnostic } from '#engine/shared/types.js';
import { EXPLANATIONS } from '#engine/shared/explain/index.js';
import { parseSize } from '#engine/project/sizes.js';
import { langFiles } from '#engine/project/lang-files.js';

type Kind = 'text' | 'number' | 'bool' | 'list' | 'block';
interface KeyRule { kinds: Kind[]; values?: string[]; doc: string }
// every block muten reads, and what each of its keys holds. `plugins` and `env` are open: their keys are names you choose.
const SCHEMA: { readonly [block: string]: { readonly [key: string]: KeyRule } } = {
  dev: {
    port: { kinds: ['number'], doc: 'the dev server port (5173 by default)' },
    host: { kinds: ['text'], values: ['lan', '0.0.0.0'], doc: '"lan" opens the dev server to the wifi' },
    hosts: { kinds: ['list'], doc: 'domain names allowed to reach the dev server, like ["dev.example.com"]' },
    devtools: { kinds: ['bool'], doc: 'false hides the devtools muten dev shows (it is on by default, and never in a build)' },
  },
  security: {
    csp: { kinds: ['text', 'bool'], doc: '"default", "off", or your own Content-Security-Policy' },
    frame: { kinds: ['text'], values: ['self', 'deny', 'any'], doc: 'who may put the app in an iframe' },
    headers: { kinds: ['text', 'bool'], values: ['off'], doc: '"off" writes no _headers file' },
  },
  css: {
    prune: { kinds: ['bool'], doc: 'false keeps every CSS rule, even ones no page can match' },
    routes: { kinds: ['bool'], doc: 'false keeps one stylesheet for the whole app instead of one per route' },
  },
  prerender: {
    skip: { kinds: ['list'], doc: 'routes left as the empty shell, like ["/search"] (a :param, a guard or live data already are)' },
    allow: { kinds: ['list'], doc: 'hosts that may answer while a page is drawn, like ["fonts.googleapis.com", "fonts.gstatic.com"]' },
    wait: { kinds: ['number'], doc: 'how long the page text must stay still to count as drawn, in ms (1000)' },
    screen: { kinds: ['text'], values: ['desktop', 'phone'], doc: 'the screen each page is drawn on: what the app sets from its own measurements is that screen\'s' },
  },
  budget: {
    js: { kinds: ['text', 'number'], doc: 'the most JS a route may ship to open, gzipped, like "150kb" (bundle fails above it)' },
    css: { kinds: ['text', 'number'], doc: 'the most the stylesheet may weigh, gzipped, like "50kb" (bundle fails above it)' },
  },
  i18n: {
    languages: { kinds: ['list'], doc: 'the languages the app ships, like ["es", "en"]: each is a src/lang/<code>.lang (a file not listed stays out)' },
    default: { kinds: ['text'], doc: 'the language a reader starts in when nothing else matches, and the first a missing text falls back to' },
    detect: { kinds: ['bool'], doc: 'false: the browser\'s language does not count; a reader starts in the default until they choose' },
  },
  routes: {
    preload: { kinds: ['text'], values: ['intent', 'visible', 'idle', 'none'], doc: 'when the next routes start loading: on intent (hover, touch, focus; the default), as their links come into view, all once the browser is idle, or never' },
  },
  pwa: {
    name: { kinds: ['text'], doc: 'the app\'s name when installed (index.html\'s <title> by default)' },
    short: { kinds: ['text'], doc: 'the name under the icon on a home screen' },
    color: { kinds: ['text'], doc: 'the theme color: the phone\'s bar and the installed window, like "#6B46F2"' },
    background: { kinds: ['text'], doc: 'the color behind the icon while the app opens' },
    icons: { kinds: ['list'], doc: 'the icon files, like ["public/icon-192.png", "public/icon-512.png"] (a phone installs only with a 192 and a 512)' },
    icon: { kinds: ['text'], doc: 'one icon file, when there is a single (big) one' },
    display: { kinds: ['text'], values: ['standalone', 'fullscreen', 'minimal-ui', 'browser'], doc: 'how the installed app opens' },
    offline: { kinds: ['bool'], doc: 'true writes a service worker: the app opens without a network (pages fresh when there is one)' },
  },
  islands: {
    react: { kinds: ['text'], values: ['react', 'preact'], doc: '"preact" runs every React island on preact/compat (about 4 KB gz instead of React\'s 45); "react" by default' },
  },
  styling: {
    prefix: { kinds: ['block'], doc: 'how theme sections map to the CSS library\'s variables' },
    blocks: { kinds: ['block'], doc: 'the CSS blocks the theme is written into' },
    classes: { kinds: ['block'], doc: 'the classes a Form part gets' },
  },
};
const OPEN_BLOCKS = ['plugins', 'env', 'lint'];
/** What a `lint { code level }` line may set a finding to. */
export const LINT_LEVELS = ['off', 'warning', 'error'];
const BLOCKS = [...Object.keys(SCHEMA), ...OPEN_BLOCKS];

const kindOf = (value: ConfigValue): Kind => (typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : Array.isArray(value) ? 'list' : 'block');

/** muten.config's schema as data (`muten config --schema`): every block, its keys, what each holds, and the open ones. */
export function configSchema(): { blocks: typeof SCHEMA; open: string[]; lint: { levels: string[]; codes: string[] } } {
  return { blocks: SCHEMA, open: OPEN_BLOCKS, lint: { levels: LINT_LEVELS, codes: Object.keys(EXPLANATIONS).sort() } };
}

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
    if (block === 'lint') {   // `lint { self-link off  unknown-arg error }`: each key a finding's code (explain/), each value a level
      for (const [code, level] of Object.entries(body)) {
        const at = locs[`lint.${code}`] ?? loc;
        if (!EXPLANATIONS[code]) out.push(diag('config-key', `lint: "${code}" is no finding's code (\`muten explain <code>\` lists what each means). It is ignored.`, { loc: at, suggestion: closest(code, Object.keys(EXPLANATIONS)), from: code }));
        else if (typeof level !== 'string' || !LINT_LEVELS.includes(level)) out.push(diag('config-value', `lint.${code} is one of ${LINT_LEVELS.map((v) => `"${v}"`).join(', ')}.`, { loc: at, suggestion: typeof level === 'string' ? closest(level, LINT_LEVELS) : null, from: typeof level === 'string' ? level : null }));
      }
      continue;
    }
    if (block === 'budget') {
      for (const [key, value] of Object.entries(body)) if (SCHEMA.budget[key] && parseSize(value) === undefined) out.push(diag('config-value', `budget.${key} is a size, like "150kb", not ${JSON.stringify(value)}.`, { loc: locs[`budget.${key}`] ?? loc }));
    }
    if (block === 'env') {
      for (const [name, values] of Object.entries(body)) {
        if (kindOf(values) !== 'block') { out.push(diag('config-value', `env.${name} is an environment: a block of values, like \`${name} { api "https://…" }\`.`, { loc: locs[`env.${name}`] ?? loc })); continue; }
        if (typeof values === 'object' && !Array.isArray(values)) for (const [key, value] of Object.entries(values))
          if (kindOf(value) === 'block' || kindOf(value) === 'list') out.push(diag('config-value', `env.${name}.${key}: an environment value is a "text", a number or true/false (it reaches the page as \`env.${key}\`).`, { loc: locs[`env.${name}.${key}`] ?? loc }));
      }
      continue;
    }
    if (block === 'i18n') {
      const files = langFiles(appRoot);
      const listed = Array.isArray(body.languages) ? body.languages.filter((code): code is string => typeof code === 'string') : null;
      for (const code of listed || []) if (!files[code]) out.push(diag('config-value', `i18n.languages lists "${code}", but there is no src/lang/${code}.lang: create it, or take it off the list.`, { loc: locs['i18n.languages'] ?? loc, suggestion: closest(code, Object.keys(files)), from: code }));
      if (typeof body.default === 'string' && (listed ? !listed.includes(body.default) : !files[body.default]))
        out.push(diag('config-value', `i18n.default is "${body.default}", which is not one of the app's languages (${(listed || Object.keys(files)).join(', ') || 'none'}).`, { loc: locs['i18n.default'] ?? loc, suggestion: closest(body.default, listed || Object.keys(files)), from: body.default }));
    }
    if (block === 'pwa') {
      const icons = Array.isArray(body.icons) ? body.icons.filter((icon): icon is string => typeof icon === 'string') : typeof body.icon === 'string' ? [body.icon] : [];
      for (const icon of icons) if (!existsSync(join(appRoot, icon))) out.push(diag('config-value', `pwa: the icon "${icon}" does not exist (a path from the app's root, like "public/icon-512.png").`, { loc: locs['pwa.icons'] ?? locs['pwa.icon'] ?? loc, from: icon }));
    }
    if (block === 'islands' && body.react === 'preact' && !packageDir(appRoot, 'preact'))
      out.push(diag('config-value', 'islands.react is "preact", but preact is not installed, so the bundle cannot find it: `npm i preact`.', { loc: locs['islands.react'] ?? loc, from: 'preact' }));
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
