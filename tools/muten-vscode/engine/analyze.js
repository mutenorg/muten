// PROJECT-AWARE analysis — the engine behind the "smart" linter/autocomplete.
//
// Unlike a single-file linter, this knows the WHOLE app:
//  - loads all parts (shared `src/parts/` + local `pages/<route>/parts/`), so it resolves
//    instances (`Changelog()`) and catches typos in part names;
//  - hoists the state of used parts, so `@refs` are validated for real;
//  - knows which parts and which `@state` to offer in autocomplete.
//
// Uses node:fs (runs in the extension host and in Node). Consumed by extension.js and the CLI.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from './parse.js';
import { toDoc } from './flatten.js';
import { compose } from './compose.js';
import { validate } from './validate.js';
import { closest } from './diagnostics.js';
import { PRIMITIVE_NAMES } from './manifest.js';

// loads parts from a folder (without styles: the lint doesn't need them)
function loadPartsLite(dir) {
  const parts = {};
  let files;
  try { files = fs.readdirSync(dir); } catch { return parts; }
  for (const f of files) {
    if (!f.endsWith('.muten')) continue;
    let ir;
    try { ir = parse(fs.readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const [name, def] of Object.entries(ir.parts || {})) {
      parts[name] = { ...def, state: ir.state || {}, entities: ir.entities || {} };
    }
  }
  return parts;
}

// walks up until it finds the app root (the one with src/pages)
function findAppRoot(filePath) {
  let dir = dirname(filePath);
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(join(dir, 'src', 'pages'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// every `parts/` folder under the app's src/ (parts are app-global)
function allPartsDirs(root) {
  const dirs = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(d, e.name);
      if (e.name === 'parts') dirs.push(full);
      else walk(full);
    }
  };
  walk(join(root, 'src'));
  return dirs;
}

export function projectParts(filePath) {
  const appRoot = findAppRoot(filePath);
  if (!appRoot) return loadPartsLite(join(dirname(filePath), 'parts'));
  const parts = {};
  for (const d of allPartsDirs(appRoot)) Object.assign(parts, loadPartsLite(d));
  return parts;
}

// lint the ROOT file (app.muten): every route must point to an existing page; no dup urls.
function analyzeRoutes(filePath, routes) {
  const appRoot = findAppRoot(filePath);
  const pagesDir = appRoot ? join(appRoot, 'src', 'pages') : null;
  let pageNames = [];
  if (pagesDir) { try { pageNames = fs.readdirSync(pagesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* no pages dir */ } }
  const D = [];
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r.url)) D.push({ code: 'dup-route', severity: 'error', message: `duplicate route "${r.url}"`, loc: r.loc, suggestion: null });
    seen.add(r.url);
    if (pagesDir && !pageNames.includes(r.page)) {
      D.push({ code: 'unknown-page', severity: 'error', message: `route "${r.url}" → page "${r.page}" not found in src/pages/`, loc: r.loc, suggestion: closest(r.page, pageNames) });
    }
  }
  return { ok: D.length === 0, diagnostics: D };
}

// diagnostics for a file, aware of the whole app
export function analyze(filePath, text) {
  let ir;
  try { ir = parse(text); }
  catch (e) {
    return { diagnostics: e && e.loc ? [{ code: 'syntax', severity: 'error', message: String(e.message), loc: e.loc, suggestion: null }] : [] };
  }
  if (ir.routes) return analyzeRoutes(filePath, ir.routes); // app.muten = ROOT file, not a page
  const parts = projectParts(filePath);
  const { tree, used } = compose(ir.tree, parts); // resolve parts; typos survive and get flagged
  const entities = { ...ir.entities };
  const state = { ...ir.state };
  for (const n of used) { const p = parts[n]; if (p) { Object.assign(entities, p.entities); Object.assign(state, p.state); } }
  const doc = toDoc({ screen: ir.screen, entities, state, actions: ir.actions, tree });
  return validate(doc, { parts: Object.keys(parts) });
}

// autocomplete context: the parts, state and actions this file knows within the WHOLE app
export function completion(filePath, text) {
  let ir = {};
  try { ir = parse(text); } catch { /* whatever could be parsed */ }
  const parts = projectParts(filePath);

  const partList = Object.entries(parts).map(([name, def]) => ({ name, params: def.params || [] }));

  const stateList = [];
  const addState = (name, d) => stateList.push({
    name, type: d.type || '',
    query: !!(d && typeof d.source === 'string' && d.source.startsWith('query:')),
  });
  for (const [n, d] of Object.entries(ir.state || {})) addState(n, d);
  for (const def of Object.values(parts)) for (const [n, d] of Object.entries(def.state || {})) addState(n, d); // hoisted

  return { parts: partList, state: stateList, actions: Object.keys(ir.actions || {}), primitives: PRIMITIVE_NAMES };
}
