// load — a .muten page → everything needed to compile it (the project-aware loader).
//   - parse the .muten -> IR
//   - gather parts: SHARED (src/parts/) + LOCAL (pages/<route>/parts/) + inline
//   - COMPOSE (inline the part instances) -> tree of primitives
//   - HOIST entity/state/mock of the USED parts (per-component data)
//   - gather STYLES: page (page.scss) + each used part's .scss (per-component styles)
//   - flatten and resolve the data
//
// The engine imposes nothing. (v1 hoist: page-level data/styles; per-instance isolation
// is a next step.)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { resolveStyles } from '#engine/project/styles.js';
import { compose } from '#engine/ir/compose.js';
import type { PartDef, Value, LoadResult } from '#engine/shared/types.js';

type Parts = { [name: string]: PartDef };

// Each part file contributes its parts + its state/entities/mock + its colocated .scss.
export async function loadParts(dir: string): Promise<Parts> {
  const parts: Parts = {};
  if (!existsSync(dir)) return parts;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.muten')) continue;
    const filePath = join(dir, f);
    const ir = parse(readFileSync(filePath, 'utf8'));
    const { css } = await resolveStyles(filePath); // the part's colocated .scss/.css
    for (const [name, def] of Object.entries(ir.parts || {})) {
      parts[name] = { ...def, state: ir.state || {}, entities: ir.entities || {}, mock: ir.mock || {}, css };
    }
  }
  return parts;
}

// Gather ALL parts in the app (any `parts/` folder under src/) → parts are app-GLOBAL:
// a part defined anywhere is usable (and autocompletes) anywhere.
export async function loadAllParts(appRoot: string): Promise<Parts> {
  const all: Parts = {};
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

  const localParts = await loadParts(join(dirname(screenPath), 'parts')); // THIS page's parts
  const inlineParts: Parts = {};                                          // parts declared in the .muten itself
  for (const [name, def] of Object.entries(ir.parts || {})) inlineParts[name] = { ...def, state: {}, entities: {}, mock: {}, css: '' };
  const parts: Parts = { ...sharedParts, ...localParts, ...inlineParts };  // local overrides shared

  const { tree, used } = compose(ir.tree, parts);                          // inline parts -> flat tree

  // hoist: the USED parts contribute entity/state/mock to the page
  const entities = { ...ir.entities };
  const state = { ...ir.state };
  let mock: { [name: string]: Value } = { ...(ir.mock || {}) };
  for (const name of used) {
    const p = parts[name];
    if (!p) continue;
    Object.assign(entities, p.entities);
    Object.assign(state, p.state);
    mock = { ...mock, ...p.mock };
  }

  const doc = toDoc({ screen: ir.screen, entities, state, actions: ir.actions, consts: ir.consts, constraints: ir.constraints, tree });

  const dataPath = screenPath.replace(/\.muten$/, '.data.json');
  const fileData: { [name: string]: Value } = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : {};
  const data = { ...fileData, ...mock };

  // styles: page-level + each used part's .scss (only injected if the part is used)
  const pageStyles = await resolveStyles(screenPath);
  const partCss = used.map((n) => parts[n]?.css).filter(Boolean).join('\n\n');
  const css = [pageStyles.css, partCss].filter(Boolean).join('\n\n');

  return { ir, doc, data, sources: ir.sources || {}, styles: { css, from: pageStyles.from }, partNames: Object.keys(parts) };
}
