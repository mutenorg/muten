// npm-types: what a `use`'d function says about itself in TypeScript: its package's .d.ts (or the .ts file it comes
// from), read so `use lookup from "pkg"` needs no hand-written entity and its calls are checked:
//   export declare function lookup(q: string, limit?: number): Promise<Hit[]>;   → returns list<Hit>, takes 1 to 2 values
//   export interface Hit { id: number; name: string }                            → entity Hit { name text } (id is muten's)
// A small reader, not TypeScript: exported functions, interfaces and object type aliases with plain fields. What it
// cannot read is left unchecked, exactly as before; a type the page declares itself always wins.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { packageDir } from '#engine/project/theme-library.js';
import { serverOnly } from '#engine/project/server-packages.js';
import { OWN_FILE } from '#engine/compile/foreign.js';
import type { Entity, FieldType, IR } from '#engine/shared/types.js';

interface FnType { min: number; max: number; returns: string }
interface ModuleTypes { fns: { [name: string]: FnType }; shapes: { [name: string]: Entity } }

const SCALAR: { readonly [ts: string]: FieldType } = { string: 'string', number: 'number', boolean: 'bool', Date: 'string' };

// the declarations file a `use` source stands for: a package's types, or a local .ts/.d.ts
function typesFile(from: string, pageFile: string, appRoot: string): string {
  if (from.startsWith('.') || from.startsWith('~/') || from.startsWith('/')) {
    const base = from.startsWith('~/') ? join(appRoot, 'src', from.slice(2)) : from.startsWith('/') ? join(appRoot, from.slice(1)) : resolve(dirname(pageFile), from);
    for (const file of [base, base.replace(/\.(m?js|ts)$/, '.d.ts'), `${base}.ts`, `${base}.d.ts`]) if (/\.ts$/.test(file) && existsSync(file)) return file;
    return '';
  }
  const pkg = from.startsWith('@') ? from.split('/').slice(0, 2).join('/') : from.split('/')[0];
  const dir = packageDir(appRoot, pkg);
  if (!dir) return '';
  let manifest: unknown = {};
  try { manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { manifest = {}; }
  const declared = manifest && typeof manifest === 'object' && !Array.isArray(manifest) && 'types' in manifest && typeof manifest.types === 'string' ? manifest.types
    : manifest && typeof manifest === 'object' && !Array.isArray(manifest) && 'typings' in manifest && typeof manifest.typings === 'string' ? manifest.typings : 'index.d.ts';
  const file = join(dir, declared);
  return existsSync(file) ? file : '';
}

// a TypeScript type as muten writes it ('' when it is not one muten can say)
function mutenType(ts: string, shapes: Set<string>): string {
  const type = ts.trim().replace(/^readonly\s+/, '');
  const promise = /^Promise<(.+)>$/.exec(type);
  if (promise) return mutenType(promise[1], shapes);
  const array = /^(.+)\[\]$/.exec(type) || /^(?:Readonly)?Array<(.+)>$/.exec(type);
  if (array) { const inner = mutenType(array[1], shapes); return inner && !inner.startsWith('list<') ? `list<${inner === 'string' ? 'text' : inner}>` : ''; }
  if (SCALAR[type]) return SCALAR[type] === 'string' ? 'text' : SCALAR[type];
  if (/^"[^"]*"(\s*\|\s*"[^"]*")+$/.test(type) || /^'[^']*'(\s*\|\s*'[^']*')+$/.test(type)) return 'text';   // a union of strings
  const nullable = /^(.+?)\s*\|\s*(null|undefined)$/.exec(type);
  if (nullable) return mutenType(nullable[1], shapes);
  return shapes.has(type) ? type : '';
}

/** The exported functions and shapes a declarations file describes. */
export function readTypes(text: string): ModuleTypes {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const shapeNames = new Set([...source.matchAll(/export\s+(?:declare\s+)?(?:interface|type)\s+([A-Z]\w*)/g)].map((m) => m[1]));
  const shapes: { [name: string]: Entity } = {};
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:interface\s+([A-Z]\w*)[^{]*|type\s+([A-Z]\w*)\s*=\s*)\{([^{}]*)\}/g)) {
    const entity: Entity = {};
    for (const field of match[3].split(/[;,\n]/)) {
      const parts = /^\s*(?:readonly\s+)?(\w+)\??\s*:\s*(.+?)\s*$/.exec(field);
      if (!parts || parts[1] === 'id') continue;
      const type = mutenType(parts[2], shapeNames);
      if (type && !type.startsWith('list<') && !shapeNames.has(type)) entity[parts[1]] = type === 'text' ? 'string' : type;
      else if (/^list<(text|number|bool)>$/.test(type)) entity[parts[1]] = type.replace('text', 'string');
    }
    shapes[match[1] || match[2]] = { id: 'uuid', ...entity };
  }
  const fns: { [name: string]: FnType } = {};
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^;{]+))?/g)) {
    const params = match[2].split(',').map((p) => p.trim()).filter(Boolean);
    const rest = params.some((p) => p.startsWith('...'));
    const required = params.filter((p) => !p.startsWith('...') && !/^\w+\?/.test(p) && !/=/.test(p)).length;
    fns[match[1]] = { min: required, max: rest ? Infinity : params.length, returns: match[3] ? mutenType(match[3], shapeNames) : '' };
  }
  return { fns, shapes };
}

/** The IR with what its `use`'d functions declare: their return types and arity, and the shapes they return as entities. */
export function withUseTypes(ir: IR, pageFile: string, appRoot: string): IR {
  const imports = (ir.imports || []).map((def) => {
    if (def.kind) return def;   // components: their props are checked against their own declarations elsewhere
    const server = OWN_FILE.test(def.from) ? '' : serverOnly(def.from, appRoot);
    if (server) return { ...def, server };
    const file = typesFile(def.from, pageFile, appRoot);
    if (!file) return def;
    let types: ModuleTypes;
    try { types = readTypes(readFileSync(file, 'utf8')); } catch { return def; }
    const returns = { ...(def.returns || {}) };
    const arity = { ...(def.arity || {}) };
    for (const name of def.names) {
      const fn = types.fns[name];
      if (!fn) continue;
      if (!returns[name] && fn.returns) returns[name] = fn.returns;
      arity[name] = { min: fn.min, max: fn.max === Infinity ? -1 : fn.max };
      const shape = /^list<(\w+)>$/.exec(fn.returns)?.[1] ?? fn.returns;
      if (types.shapes[shape] && !ir.entities?.[shape]) ir.entities = { ...(ir.entities || {}), [shape]: types.shapes[shape] };
    }
    return { ...def, ...(Object.keys(returns).length ? { returns } : {}), ...(Object.keys(arity).length ? { arity } : {}) };
  });
  // `hits = query lookup(q)` with no type: what lookup returns, or an untyped list `check` asks to name
  const returns: { [fn: string]: string } = Object.assign({}, ...imports.map((def) => def.returns || {}));
  const state = Object.fromEntries(Object.entries(ir.state || {}).map(([name, def]) => [name, def.call && !def.type ? { ...def, type: def.call.chain ? '' : returns[def.call.fn] || '' } : def]));
  return { ...ir, imports, state };
}
