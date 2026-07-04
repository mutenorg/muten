// load: project-aware loader that turns a .muten page into everything needed to compile it.
// Pipeline: parse -> gather parts (shared + local + inline) -> compose (inline instances) ->
// hoist entity/state/mock of used parts -> gather styles (page + used parts) -> flatten data.
// Consumed by build.ts, map.ts, and the runner.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from '#engine/lang/parse.js';
import { PRIMITIVES } from '#engine/lang/manifest.js';
import { resolveStyles } from '#engine/project/styles.js';
import { composeDoc } from '#engine/ir/compose.js';
import { readMutenConfig } from '#engine/project/config.js';
import type { PartDef, Value, LoadResult, IR, Entity } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

// A plugin registry's index (registry.json). `file` is the part to import; `component` (if present) names a
// Custom-backed entry whose host .js sits next to `file` (chart.muten -> chart.js) and is inlined at compile.
interface PluginRegistry { components?: { file: string; component?: string }[]; }

// Parts IMPORTED from installed plugins declared in `muten.config`:  plugins { shadcn {} }  ->  @muten/shadcn.
// This is the "use without owning" path (the registry seam); `muten add` copies a part into src/parts to eject + own it.
// Local src/parts always win (so an ejected copy overrides the imported one) - see loadAllParts merge order.
// EVERY registry part is imported - including Custom-backed ones (Chart, Calendar, …); their host .js is resolved
// from the plugin by loadPluginComponents (below), so `plugins {}` gives you the full catalog without ejecting.
export async function loadPluginParts(appRoot: string): Promise<Parts> {
  const out: Parts = {};
  const plugins = readMutenConfig(appRoot).plugins;
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return out;
  let req;
  try { req = createRequire(join(appRoot, 'package.json')); } catch { return out; }
  for (const name of Object.keys(plugins)) {
    let regPath;
    try { regPath = req.resolve(`@muten/${name}/registry.json`); } catch { continue; } // not installed / not a registry plugin
    let reg: PluginRegistry;
    try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { continue; }
    const dir = dirname(regPath);
    for (const c of reg.components || []) {
      const filePath = join(dir, c.file);
      if (!existsSync(filePath)) continue;
      // A plugin part that SHADOWS a native primitive (e.g. an older shadcn `Checkbox`/`Select`/`Chart` after the
      // core gained those primitives) must NOT brick the whole app — the primitive wins; skip the plugin part.
      // Any other parse error in a plugin file is also non-fatal (the plugin is not the user's code). Local parts
      // still hard-error on shadow (parse.ts), where a rename is the right fix.
      let ir;
      try { ir = parse(readFileSync(filePath, 'utf8')); } catch { continue; }
      const { css } = await resolveStyles(filePath);
      for (const [partName, def] of Object.entries(ir.parts || {}))
        if (!(partName in PRIMITIVES)) out[partName] = { ...def, state: ir.state || {}, entities: ir.entities || {}, mock: ir.mock || {}, css }; // primitive-named plugin parts yield to the primitive
    }
  }
  return out;
}

// Host .js for the Custom-backed registry entries of installed plugins, keyed by the Custom's component name.
// So an imported plugin part (`Chart(data: …)` -> `Custom Chart …`) can find its host source in node_modules.
// A LOCAL src/components/<Name>.js still wins at compile (that's how `muten add` ejects + owns a Custom).
export function loadPluginComponents(appRoot: string): { [component: string]: string } {
  const out: { [component: string]: string } = {};
  const plugins = readMutenConfig(appRoot).plugins;
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return out;
  let req;
  try { req = createRequire(join(appRoot, 'package.json')); } catch { return out; }
  for (const name of Object.keys(plugins)) {
    let regPath;
    try { regPath = req.resolve(`@muten/${name}/registry.json`); } catch { continue; }
    let reg: PluginRegistry;
    try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { continue; }
    const dir = dirname(regPath);
    for (const c of reg.components || []) {
      if (!c.component) continue;
      const js = join(dir, c.file.replace(/\.muten$/, '.js'));
      if (existsSync(js)) out[c.component] = js;
    }
  }
  return out;
}

// Element entity of each store's list-typed STATE member, keyed "domain.member" — so a PAGE doing a
// cross-store aggregate (`orders.items.count where status == …`) can resolve the element's fields the
// same way it resolves a local list. (State members only; a get returning a list is left to local resolution.)
export function storeListEntities(stores: { [domain: string]: IR }): { [k: string]: Entity } {
  const out: { [k: string]: Entity } = {};
  for (const [domain, ir] of Object.entries(stores)) {
    for (const [member, def] of Object.entries(ir.state || {})) {
      const m = (def.type || '').match(/^list<(.+)>$/);
      const ent = m ? ir.entities?.[m[1]] : undefined;
      if (ent) out[`${domain}.${member}`] = ent;
    }
  }
  return out;
}

// Every *.store file under a directory -> parsed IR keyed by domain name.
// Shared by the runner, the linter, and `muten map` so store refs resolve everywhere.
export function findStores(dir: string, out: { [domain: string]: IR } = {}): { [domain: string]: IR } {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findStores(full, out);
    else if (entry.name.endsWith('.store')) out[basename(entry.name, '.store')] = parse(readFileSync(full, 'utf8'));
  }
  return out;
}

// Each part file contributes its parts, state/entities/mock, and colocated .scss.
export async function loadParts(dir: string): Promise<Parts> {
  const parts: Parts = {};
  if (!existsSync(dir)) return parts;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.muten')) continue;
    const filePath = join(dir, f);
    const ir = parse(readFileSync(filePath, 'utf8'));
    const { css } = await resolveStyles(filePath); // colocated .scss/.css for this part
    for (const [name, def] of Object.entries(ir.parts || {})) {
      parts[name] = { ...def, state: ir.state || {}, entities: ir.entities || {}, mock: ir.mock || {}, css };
    }
  }
  return parts;
}

// Gather all parts in the app (any `parts/` folder under src/). Parts are app-global:
// defined anywhere, usable and autocompleted anywhere.
export async function loadAllParts(appRoot: string): Promise<Parts> {
  const all: Parts = await loadPluginParts(appRoot); // imported plugin parts first - local src/parts below override them
  const dirs: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(d, e.name);
      if (e.name === 'parts') dirs.push(full);
      else walk(full);
    }
  };
  walk(join(appRoot, 'src'));
  for (const d of dirs) Object.assign(all, await loadParts(d));
  return all;
}

export async function load(screenPath: string, sharedParts: Parts = {}): Promise<LoadResult> {
  const ir = parse(readFileSync(screenPath, 'utf8'));

  const localParts = await loadParts(join(dirname(screenPath), 'parts')); // parts local to this page
  const inlineParts: Parts = {};                                          // parts declared inline in the .muten
  for (const [name, def] of Object.entries(ir.parts || {})) inlineParts[name] = { ...def, state: {}, entities: {}, mock: {}, css: '' };
  const parts: Parts = { ...sharedParts, ...localParts, ...inlineParts };  // local wins over shared

  const { doc, used } = composeDoc(ir, parts); // inline parts + hoist entity/state -> flat doc

  // hoist used parts' mock data for build-time rendering
  let mock: { [name: string]: Value } = { ...(ir.mock || {}) };
  for (const name of used) { const p = parts[name]; if (p) mock = { ...mock, ...p.mock }; }

  const dataPath = screenPath.replace(/\.muten$/, '.data.json');
  const fileData: { [name: string]: Value } = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : {};
  const data = { ...fileData, ...mock };

  // styles: page-level + each used part's .scss (skipped if the part is unused)
  const pageStyles = await resolveStyles(screenPath);
  const partCss = used.map((n) => parts[n]?.css).filter(Boolean).join('\n\n');
  const css = [pageStyles.css, partCss].filter(Boolean).join('\n\n');

  return { ir, doc, data, sources: ir.sources || {}, styles: { css, from: pageStyles.from }, partNames: Object.keys(parts) };
}
