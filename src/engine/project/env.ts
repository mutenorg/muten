// env: the app's environments, declared in muten.config, read in muten as `env.<key>`.
//
//   env {
//     local { api "http://localhost:4310" }
//     lan   { api "http://192.168.1.20:4310" }
//     prod  { api "https://api.example.com" }
//   }
//
// `muten dev` runs on `local`, `muten bundle` and `muten build` on `prod`; `--env=<name>` (or MUTEN_ENV) picks another.
// It replaces the scripts that REWROTE the source to point an app elsewhere (a forgotten one sealed a phone build to
// localhost: a blank screen, no error). In muten, `env` is a read-only store: `Text "{env.api}"`, and the api block
// takes it inside a string, `api { base: "{env.api}" }`. `check` knows its keys, so a typo is an error.
import { parse } from '#engine/lang/parse.js';
import { readMutenConfig, type ConfigBlock, type ConfigValue } from '#engine/project/config.js';
import type { IR, Value } from '#engine/shared/types.js';

/** The name `env` values are read through, as a store domain. */
export const ENV_DOMAIN = 'env';
/** The environment variable the CLI sets for the command (and that picks one by hand). */
export const ENV_VARIABLE = 'MUTEN_ENV';

type EnvScalar = string | number | boolean;
export interface EnvValues { [key: string]: EnvScalar }

function scalarsOf(block: ConfigValue | undefined): EnvValues {
  const out: EnvValues = {};
  if (!block || typeof block !== 'object' || Array.isArray(block)) return out;
  for (const [key, value] of Object.entries(block)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  return out;
}

function envBlocks(appRoot: string): ConfigBlock | null {
  const env = readMutenConfig(appRoot)[ENV_DOMAIN];
  return env && Object.keys(env).length ? env : null;
}

/** Does muten.config declare an environment with this name? (A default that isn't declared is just not applied.) */
export function hasEnvironment(appRoot: string, name: string): boolean {
  const blocks = envBlocks(appRoot);
  return !!blocks && name in blocks;
}

/** The values of the active environment; with none chosen (the editor, `check`), every key any environment has. */
export function envValues(appRoot: string): EnvValues | null {
  const blocks = envBlocks(appRoot);
  if (!blocks) return null;
  const chosen = process.env[ENV_VARIABLE];
  if (chosen) {
    if (!(chosen in blocks)) throw new Error(`muten.config: no environment "${chosen}" in env { } (there is ${Object.keys(blocks).join(', ')})`);
    return scalarsOf(blocks[chosen]);
  }
  const union: EnvValues = {};
  for (const block of Object.values(blocks).reverse()) Object.assign(union, scalarsOf(block));
  return union;
}

/** `env` as a store IR (one state per key), or null when the app declares no environments. */
export function envStore(appRoot: string): IR | null {
  const values = envValues(appRoot);
  if (!values) return null;
  const entries = Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)} : ${typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'bool' : 'text'}`);
  return parse(`state { ${entries.join('  ')} }`);
}

/** The api block of app.muten with every `{env.key}` in its strings replaced by the active environment's value. */
export function apiWithEnv(api: { [name: string]: Value }, appRoot: string): { [name: string]: Value } {
  const values = envValues(appRoot);
  if (!values) return api;
  const fill = (item: Value): Value => {
    if (typeof item === 'string') return item.replace(/\{env\.([A-Za-z_]\w*)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
    if (Array.isArray(item)) return item.map(fill);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, fill(inner)]));
    return item;
  };
  return Object.fromEntries(Object.entries(api).map(([name, value]) => [name, fill(value)]));
}

/** For code still written in JS/TS (a `use` module, a Custom): `import.meta.env.MUTEN_API` is `env.api`, replaced at build
 *  time (esbuild `define`). The modules a script used to rewrite to point the app elsewhere read it instead. */
export function envDefines(appRoot: string): { [expression: string]: string } {
  const values = envValues(appRoot) ?? {};
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [`import.meta.env.MUTEN_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`, JSON.stringify(value)]));
}
