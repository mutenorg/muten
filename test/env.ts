// env: environments in muten.config, read as `env.<key>` (a read-only store) and inside the api block's strings.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { envValues, hasEnvironment } from '#engine/project/env.js';
import { findStores } from '#engine/project/load.js';
import { readApi } from '#engine/project/routes.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const root = mkdtempSync(join(tmpdir(), 'muten-env-'));
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'muten.config'), 'env {\n  local { api "http://localhost:4310"  debug true }\n  prod { api "https://api.example.com"  debug false  region "us" }\n}\n');
writeFileSync(join(root, 'src/app.muten'), 'api { base: "{env.api}/v1" }\nroutes {\n  "/" -> home\n}\n');

delete process.env.MUTEN_ENV;
ok('with no environment chosen, every key any environment has', JSON.stringify(Object.keys(envValues(root)).sort()) === '["api","debug","region"]', JSON.stringify(envValues(root)));
process.env.MUTEN_ENV = 'prod';
ok('the chosen environment\'s values', envValues(root).api === 'https://api.example.com' && envValues(root).debug === false);
const store = findStores(join(root, 'src')).env;
ok('env is a store, one state per key, typed', store?.state?.api?.type === 'text' && store?.state?.debug?.type === 'bool', JSON.stringify(store?.state));
ok('the api block takes {env.key} inside its strings', readApi(root).base === 'https://api.example.com/v1', JSON.stringify(readApi(root)));
process.env.MUTEN_ENV = 'local';
ok('another environment, another base', readApi(root).base === 'http://localhost:4310/v1');
ok('hasEnvironment', hasEnvironment(root, 'prod') && !hasEnvironment(root, 'staging'));
const { envDefines } = await import('#engine/project/env.js');
ok('JS reads it as import.meta.env.MUTEN_*', envDefines(root)['import.meta.env.MUTEN_API'] === '"http://localhost:4310"' && envDefines(root)['import.meta.env.MUTEN_DEBUG'] === 'true', JSON.stringify(envDefines(root)));
process.env.MUTEN_ENV = 'staging';
let threw = ''; try { envValues(root); } catch (e) { threw = e.message; }
ok('an environment that is not declared is a clear error', /no environment "staging"/.test(threw), threw);
delete process.env.MUTEN_ENV;
const bare = mkdtempSync(join(tmpdir(), 'muten-env-'));
mkdirSync(join(bare, 'src'), { recursive: true });
ok('an app without env { } has no env store', !('env' in findStores(join(bare, 'src'))) && envValues(bare) === null);
rmSync(root, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true });

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
