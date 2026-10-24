// add-package: `muten add <package>` for any npm package, the way `muten add <plugin>` is for muten's own. It installs
// it with the app's own package manager, says when it only runs on a server (and stops there), reads what it exports
// (its functions, its React components, a stylesheet), weighs what it would add to a page, and prints the `use` line to
// write and an example, so neither a person nor an agent has to guess how a package comes into a .muten file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { serverOnly } from '#engine/project/server-packages.js';
import { packageDir } from '#engine/project/theme-library.js';
import { typeOracle, type PackageExports } from '#engine/project/type-oracle.js';

const HEAVY = 60 * 1024;   // gzipped: a page carrying this much more is worth a `lazy` or its own route
const STYLESHEETS = ['dist/style.css', 'dist/index.css', 'style.css', 'index.css', 'css/index.css'];
const NODE_BUILTIN = /Could not resolve "(?:node:)?(fs|path|http|https|net|tls|crypto|child_process|cluster|dgram|worker_threads|zlib|stream|os)"/;

const MANAGERS: Array<[string, string[]]> = [['yarn.lock', ['yarn', 'add']], ['pnpm-lock.yaml', ['pnpm', 'add']], ['bun.lockb', ['bun', 'add']], ['bun.lock', ['bun', 'add']]];

/** The app's package manager, by its lock file (npm when there is none). */
function installer(root: string): string[] {
  for (const [lock, command] of MANAGERS) if (existsSync(join(root, lock))) return command;
  return ['npm', 'install'];
}

/** The app's dependencies, name → what was asked for. */
function dependencies(root: string): Map<string, string> {
  try {
    const manifest: { dependencies?: { [name: string]: string }; devDependencies?: { [name: string]: string } } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return new Map(Object.entries({ ...manifest.devDependencies, ...manifest.dependencies }));
  } catch { return new Map(); }
}

/** The package's name without a version or a subpath: `dayjs@1/plugin` → `dayjs`, `@scope/x/y` → `@scope/x`. */
const packageName = (spec: string): string => { const bare = spec.replace(/(?!^)@[^/]*$/, ''); return bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0]; };

/** A package name as a name to use it by: `dayjs` → dayjs, `canvas-confetti` → canvasConfetti, `@scope/lib` → lib. */
const identifier = (name: string): string => name.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9]+(.)/g, (_, next: string) => next.toUpperCase()).replace(/^[^a-zA-Z_$]+/, '');

/** Orders exports so the one named after the package comes first: `DayPicker` from react-day-picker, `dayjs` from dayjs. */
function closestFirst(name: string): (a: string, b: string) => number {
  const flat = name.replace(/^@[^/]+\//, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const score = (exported: string): number => flat.endsWith(exported.toLowerCase()) ? 0 : flat.includes(exported.toLowerCase()) ? 1 : 2;
  return (a, b) => score(a) - score(b);
}

/** What a package offers a .muten file: its components and functions (from its types), and a stylesheet. */
function exportsOf(root: string, name: string): PackageExports & { css: string[] } {
  const found = typeOracle(root)?.exportsOf(root, name) ?? { components: [], functions: [], callable: false };
  const dir = packageDir(root, name);
  const css: string[] = [];
  if (dir) {
    let manifest: { style?: string; exports?: string | { [subpath: string]: object | string | null } } = {};
    try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { /* no manifest */ }
    // a package with an exports map only lets you import what it lists: its shortest plain stylesheet there
    const listed = manifest.exports && typeof manifest.exports === 'object' ? Object.keys(manifest.exports) : [];
    const sheets = listed.filter((subpath) => subpath.endsWith('.css') && !subpath.includes('.module.')).sort((a, b) => a.length - b.length);
    const sheet = listed.length ? sheets[0] : [manifest.style ?? '', ...STYLESHEETS].find((guess) => guess && existsSync(join(dir, guess)));
    if (sheet) css.push(`${name}/${sheet.replace(/^\.\//, '')}`);
  }
  const named = closestFirst(name);
  // a module that is itself a function is used by its own name, the way its docs show it (`dayjs(…)`)
  const own = found.callable ? [identifier(name)] : [];
  return { components: [...found.components].sort(named), functions: [...own, ...found.functions.filter((fn) => !own.includes(fn)).sort(named)], callable: found.callable, css };
}

/** What importing the package adds to a page, gzipped (esbuild bundles it, minified, the way muten bundle would), and
 *  the Node module it needs that a browser lacks, if any: everything it imports is followed, not just its entry. */
async function weigh(root: string, name: string): Promise<{ gz: number; needsNode: string }> {
  try {
    const result = await esbuild.build({ stdin: { contents: `export * from ${JSON.stringify(name)};`, resolveDir: root, loader: 'js' }, bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent', external: ['react', 'react-dom', 'react/jsx-runtime'] });
    return { gz: result.outputFiles.reduce((sum, file) => sum + gzipSync(file.contents).length, 0), needsNode: '' };
  } catch (failure) {
    const said = failure instanceof Error ? failure.message : String(failure);
    return { gz: 0, needsNode: NODE_BUILTIN.exec(said)?.[1] ?? '' };
  }
}

/** `muten add <package>`: install, check, read, weigh, and say how to use it. True when it can be used. */
export async function addPackage(root: string, spec: string): Promise<boolean> {
  const before = dependencies(root);
  const [program, verb] = installer(root);
  console.log(`  installing ${spec} with ${program}…`);
  const run = spawnSync(process.platform === 'win32' ? program + '.cmd' : program, [verb, spec], { cwd: root, stdio: 'inherit', shell: false });
  if (run.status !== 0) { console.error(`✖ ${program} could not install ${spec} (is it on npm?)`); return false; }
  // the name is what the install wrote down: a `file:`, git or alias spec says nothing about it by itself
  const added = [...dependencies(root)].find(([dep, wanted]) => before.get(dep) !== wanted)?.[0];
  const name = added ?? packageName(spec);
  const server = serverOnly(name, root);
  if (server) { console.error(`✖ ${server}`); return false; }
  const { gz, needsNode } = await weigh(root, name);
  if (needsNode) { console.error(`✖ "${name}" needs Node's \`${needsNode}\`, which a browser does not have: it is for a server. Call it from your API (\`post "/…"\`) instead, and remove it here.`); return false; }
  const found = exportsOf(root, name);
  console.log(`✓ ${name} installed${gz ? ` · all of it is about ${Math.max(1, Math.round(gz / 1024))} KB gzipped; a page carries only what it uses` : ''}`);
  if (gz > HEAVY) console.log(`  heavy: use it on the page that needs it only, or mount it with \`Custom … lazy\` so it loads as it nears the screen`);
  const lines: Array<[string, string]> = [];
  if (found.components.length) {
    lines.push([`use ${found.components[0]} from "${name}"`, 'a React component'], [`${found.components[0]}(…)`, 'written where an element goes: mounted as an island']);
    if (!packageDir(root, 'react') || !packageDir(root, 'react-dom')) console.log(`  its components need React: ${program} ${verb} react react-dom`);
  }
  if (found.functions.length) lines.push([`use ${found.functions[0]} from "${name}"`, 'a function'], [`Text "{${found.functions[0]}(…)}"`, 'called in any expression']);
  for (const sheet of found.css) lines.push([`use "${sheet}"`, 'its stylesheet, added to the app\'s CSS']);
  if (!lines.length) lines.push([`use … from "${name}"`, 'name what you take from it (it has no types muten could read)']);
  const width = Math.max(...lines.map(([code]) => code.length)) + 3;
  const more = found.components.length + found.functions.length - (found.components.length ? 1 : 0) - (found.functions.length ? 1 : 0);
  console.log('\n  in a .muten file:\n\n' + lines.map(([code, note]) => `    ${code.padEnd(width)}# ${note}`).join('\n') + '\n');
  if (more > 0) console.log(`  it also exports ${[...found.components.slice(1), ...found.functions.slice(1)].slice(0, 8).join(', ')}${more > 8 ? `, and ${more - 8} more` : ''}\n`);
  return true;
}
