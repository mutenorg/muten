// `muten add <name...>` — the registry seam's CLI. Two kinds of name:
//   • lowercase (e.g. `devtools`, `shadcn`) = a CONNECTABLE PLUGIN → npm-install `@muten/<name>` (if needed) and
//     enable it in muten.config (`plugins { <name> {} }`). One command configures everything, like `ng add`.
//   • PascalCase (e.g. `Button`) = a registry COMPONENT → copy its source (a muten part) into src/parts/ (own it).
// The core ships this command; PLUGINS ship the registry data (registry.json) and/or the `muten.devBoot` hook.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// `component` (PascalCase) marks a Custom-backed entry: besides the .muten part, copy the sibling .js
// (same basename) into src/components/<component>.js, where muten's `Custom` primitive loads it.
interface RegistryEntry { name: string; part: string; file: string; component?: string; description?: string; deps?: string[]; }
interface Registry { name?: string; components: RegistryEntry[]; }
interface Source { dir: string; reg: Registry; }

// ── connectable plugins (`muten add devtools`) ───────────────────────────────
const isInstalled = (root: string, name: string): boolean => existsSync(join(root, 'node_modules', '@muten', name));

// Ensure `plugins { <name> {} }` in muten.config (create the block, or the file, if absent). Returns false if it
// was already enabled. Text-level edit — muten.config is muten syntax, small, and we only touch the plugins block.
function ensurePluginInConfig(root: string, name: string): boolean {
  const file = join(root, 'muten.config');
  let src = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const block = src.match(/plugins\s*\{([\s\S]*?)\n\}/);
  if (block) {
    if (new RegExp(`(^|\\s)${name}\\s*\\{`).test(block[1])) return false; // already enabled
    src = src.replace(block[0], `plugins {${block[1]}\n  ${name} {}\n}`);
  } else {
    src = src.trimEnd() + (src.trim() ? '\n\n' : '') + `plugins {\n  ${name} {}\n}\n`;
  }
  writeFileSync(file, src);
  return true;
}

function addPlugin(root: string, name: string): void {
  const pkg = `@muten/${name}`;
  if (!isInstalled(root, name)) {
    console.log(`  installing ${pkg}…`);
    const r = spawnSync('npm', ['install', '-D', pkg], { cwd: root, stdio: 'inherit', shell: true });
    if (r.status !== 0 || !isInstalled(root, name)) { console.error(`✖ could not install ${pkg} (does it exist on npm?)`); process.exit(1); }
  }
  const enabled = ensurePluginInConfig(root, name);
  console.log(`✓ ${pkg} ${enabled ? 'installed + enabled' : 'already enabled'}  (plugins { ${name} {} } in muten.config)`);
  console.log(`  restart \`muten dev\` to pick it up.`);
}

// ── registry components (`muten add Button`) ─────────────────────────────────
// A registry is any installed dependency whose package root holds a `registry.json`.
function discoverRegistries(root: string): Source[] {
  const out: Source[] = [];
  const req = createRequire(join(root, 'package.json'));
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); }
  catch { return out; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of Object.keys(deps)) {
    try {
      const regPath = req.resolve(name + '/registry.json'); // resolved via the package's exports; a dep with no registry just throws
      if (existsSync(regPath)) out.push({ dir: dirname(regPath), reg: JSON.parse(readFileSync(regPath, 'utf8')) as Registry });
    } catch { /* not a registry package — skip */ }
  }
  return out;
}

function ejectComponents(root: string, names: string[]): void {
  const sources = discoverRegistries(root);
  if (!sources.length) { console.error('✖ no component registry installed. Add one first, e.g. `muten add shadcn`.'); process.exit(1); }

  const index = new Map<string, { dir: string; entry: RegistryEntry }>();
  for (const { dir, reg } of sources) for (const e of reg.components || []) if (!index.has(e.name)) index.set(e.name, { dir, entry: e });

  const partsDir = join(root, 'src', 'parts');
  mkdirSync(partsDir, { recursive: true });

  const queue = [...names];
  const seen = new Set<string>();
  const added: string[] = [];
  let missing = false;
  while (queue.length) {
    const n = queue.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const hit = index.get(n);
    if (!hit) { console.error(`✖ unknown component "${n}" (not in any installed registry)`); missing = true; continue; }
    copyFileSync(join(hit.dir, hit.entry.file), join(partsDir, basename(hit.entry.file)));
    added.push(`${hit.entry.part}  →  src/parts/${basename(hit.entry.file)}`);
    if (hit.entry.component) { // Custom-backed: copy the host .js into src/components/ so `Custom` can load it
      const compDir = join(root, 'src', 'components');
      mkdirSync(compDir, { recursive: true });
      const jsSrc = join(hit.dir, hit.entry.file.replace(/\.muten$/, '.js'));
      if (existsSync(jsSrc)) { copyFileSync(jsSrc, join(compDir, hit.entry.component + '.js')); added.push(`${hit.entry.component} (Custom)  →  src/components/${hit.entry.component}.js`); }
    }
    for (const d of hit.entry.deps || []) if (!seen.has(d)) queue.push(d);   // pull dependencies in too
  }
  console.log(`✓ added ${added.length} component${added.length === 1 ? '' : 's'}${added.length ? ':' : ''}`);
  for (const a of added) console.log('  ' + a);
  if (missing) process.exit(1);
}

// route each name: lowercase = connectable plugin (install + configure); PascalCase = registry component (eject).
export function addComponents(root: string, names: string[]): void {
  const plugins = names.filter((n) => /^[a-z]/.test(n));
  const components = names.filter((n) => !/^[a-z]/.test(n));
  for (const p of plugins) addPlugin(root, p);
  if (components.length) ejectComponents(root, components);
}
