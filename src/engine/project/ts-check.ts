// ts-check: a page's calls into its packages, checked by TypeScript itself against the packages' own types:
//   stripe.elemnts(…)            Property 'elemnts' does not exist on type 'Stripe'. Did you mean 'elements'?
//   z.string().emial()           a step of a chain that the package does not have
//   dayjs(x).format("D", 2)      how many values a method takes
//   Calendar(selcted: day)        a prop a React component does not have, or a required one left out (its own props)
//   Map(zom: 3)                   an input or event a Custom in TypeScript (src/components/Map.ts) does not take
// muten writes those calls into one TypeScript file per page (in memory, next to the page so its node_modules resolve),
// with muten's own values as `any` (they are checked by muten), and reports what would throw at run time: a member that
// does not exist, a call with the wrong number of values, `new` on what is not a class, a name the package lacks.
// TypeScript is asked through type-oracle.ts, the one place muten talks to it; without it, nothing changes.
import { dirname, join } from 'node:path';
import { typeOracle, type TypeFinding } from '#engine/project/type-oracle.js';
import { Ek, StOp, Nt, UseKind, THEME_REF, LIVE_CHANGE } from '#engine/shared/vocab.js';
import { existsSync, readFileSync } from 'node:fs';
import { foreignNames, callValues } from '#engine/ir/calls.js';
import { themeValue } from '#engine/style/theme-ref.js';
import { getOrder } from '#engine/ir/refs.js';
import type { CallExpr, Diagnostic, Doc, Expr, Loc, Stmt, ThemeRaw } from '#engine/shared/types.js';

const ANY = '__mutenValue';
// what would throw at run time; a value of another type is muten's to check, not TypeScript's
const REPORTED = new Set([2339, 2551, 2554, 2555, 2349, 2351, 7009, 2305, 2614, 2724, 2307, 2353, 2741]);
const PROP_CODES = new Set([2353, 2741]);   // a prop the component does not have / a required one left out
const OWN_FILE = /^(\.|~\/|\/)/;
const MISSING_MODULE = 2307;
const CUSTOM_PREFIX = 'Custom ';
const EXPORTED_MOUNT = /^[ \t]*export[ \t]+(?:(?:async[ \t]+)?function[ \t]+mount\b|const[ \t]+mount\b)/m;   // a line that checks a TypeScript Custom's call, told apart in the finding's words

interface Line { code: string; loc: Loc | null; what: string }

// one page as TypeScript: its imports, the gets and queries that hold a package's values, then each call into a package
function pageSource(doc: Doc, appRoot: string, theme: ThemeRaw | undefined): Line[] {
  const foreign = foreignNames(doc);
  const lines: Line[] = [{ code: `declare const ${ANY}: any; declare const ${LIVE_CHANGE}: (value: any) => void;`, loc: null, what: '' }];
  const print = (e: Expr): string => {
    switch (e.kind) {
      case Ek.Lit: return JSON.stringify(e.value);
      case Ek.Ref: {
        const head = e.name.split('.')[0];
        if (head === THEME_REF && theme) return JSON.stringify(themeValue(theme, e.name.split('.').slice(1)) ?? null);
        return foreign.has(head) ? e.name : ANY;
      }
      case Ek.Call: return foreign.has(e.fn.split('.')[0]) ? `${e.ctor ? 'new ' : ''}${e.fn}(${e.args.map(print).join(', ')})${(e.chain || []).map((step) => `.${step.name}${step.args ? `(${step.args.map(print).join(', ')})` : ''}`).join('')}` : ANY;
      case Ek.Obj: return `{ ${e.fields.map((field) => `${JSON.stringify(field.key)}: ${print(field.value)}`).join(', ')} }`;
      case Ek.List: return `[${e.items.map(print).join(', ')}]`;
      case Ek.Tern: return `(${print(e.cond)} ? ${print(e.then)} : ${print(e.else)})`;
      default: return ANY;
    }
  };
  const reactTypes = existsSync(join(appRoot, 'node_modules', '@types', 'react'));
  for (const [index, def] of (doc.imports || []).entries()) {
    if (def.kind === UseKind.React && reactTypes && !OWN_FILE.test(def.from)) {   // a React component: its props, checked below
      lines.push({ code: `import * as __pkg${index} from ${JSON.stringify(def.from)};`, loc: def.loc ?? null, what: def.from });
      for (const name of def.names) lines.push({ code: `const ${name} = null as unknown as (typeof __pkg${index} extends { ${name}: infer T } ? T : typeof __pkg${index} extends { default: infer D } ? (D extends { ${name}: infer N } ? N : D) : any);`, loc: def.loc ?? null, what: name });
      continue;
    }
    if (def.kind) continue;
    if (def.script) { lines.push({ code: def.names.map((name) => `declare const ${name}: any;`).join(' '), loc: null, what: '' }); continue; }   // a global by <script>: no types to read
    const from = def.from.startsWith('~/') ? join(appRoot, 'src', def.from.slice(2)) : def.from;
    lines.push({ code: OWN_FILE.test(def.from) ? `import { ${def.names.join(', ')} } from ${JSON.stringify(from)};` : `import * as __pkg${index} from ${JSON.stringify(from)};`, loc: def.loc ?? null, what: def.from });
    if (!OWN_FILE.test(def.from)) for (const name of def.names) lines.push({ code: `const ${name} = null as unknown as (typeof __pkg${index} extends { ${name}: infer T } ? T : typeof __pkg${index} extends { default: infer D } ? (D extends { ${name}: infer N } ? N : D) : any);`, loc: def.loc ?? null, what: name });
  }
  const gets = doc.gets || {};
  for (const name of getOrder({ state: doc.state || {}, gets, entities: doc.entities || {} })) {
    if (foreign.has(name)) lines.push({ code: `const ${name} = ${print(gets[name])};`, loc: doc.getLocs?.[name] ?? null, what: name });
  }
  for (const [name, def] of Object.entries(doc.state || {})) {
    if (!def.call) continue;
    lines.push({ code: def.live ? `declare const ${name}: any;` : `const __asked_${name} = ${print(def.call)}; const ${name} = null as unknown as Awaited<typeof __asked_${name}>;`, loc: def.loc ?? null, what: name });
  }
  // every call into a package, wherever it is written
  const calls: Array<{ call: CallExpr; loc: Loc | null }> = [];
  const collect = (e: Expr | undefined, loc: Loc | null): void => {
    if (!e) return;
    if (e.kind === Ek.Call && (foreign.has(e.fn.split('.')[0]))) { calls.push({ call: e, loc }); return; }
    if (e.kind === Ek.Call) for (const arg of callValues(e)) collect(arg, loc);
    else if (e.kind === Ek.Bin) { collect(e.left, loc); collect(e.right, loc); }
    else if (e.kind === Ek.Un) collect(e.operand, loc);
    else if (e.kind === Ek.Tern) { collect(e.cond, loc); collect(e.then, loc); collect(e.else, loc); }
    else if (e.kind === Ek.Obj) for (const field of e.fields) collect(field.value, loc);
    else if (e.kind === Ek.List) for (const item of e.items) collect(item, loc);
  };
  const statement = (st: Stmt): void => {
    const loc = st.loc ?? null;
    if (st.op === StOp.If) { collect(st.cond, loc); for (const inner of [...(st.then || []), ...(st.else || [])]) statement(inner); return; }
    if (st.op === StOp.Extern && foreign.has(st.fn.split('.')[0])) { calls.push({ call: { kind: Ek.Call, fn: st.fn, args: st.args, ...(st.chain ? { chain: st.chain } : {}), ...(st.ctor ? { ctor: true } : {}) }, loc }); return; }
    if (st.op === StOp.Call && foreign.has(st.target)) { calls.push({ call: { kind: Ek.Call, fn: `${st.target}.${st.method}`, args: st.args }, loc }); return; }
    if ('args' in st) for (const arg of st.args) collect(arg, loc);
    if ('arg' in st) collect(st.arg, loc);
  };
  for (const action of Object.values(doc.actions || {})) for (const st of [...(action.body || []), ...(action.failed || [])]) statement(st);
  for (const body of doc.effects || []) for (const st of body) statement(st);
  for (const [name, body] of Object.entries(gets)) if (!foreign.has(name)) collect(body, doc.getLocs?.[name] ?? null);
  for (const def of Object.values(doc.state || {})) collect(def.feed, def.loc ?? null);
  for (const node of Object.values(doc.nodes || {})) {
    const props = node.props || {};
    const loc = node.loc ?? null;
    for (const value of [props.value, props.label]) if (value && typeof value === 'object' && 'parts' in value) for (const part of value.parts) if (typeof part !== 'string') collect(part, loc);
    for (const value of Object.values(props.inputs || {})) if (typeof value === 'object' && '$expr' in value) collect(value.$expr, loc);
    collect(props.cond, loc);
  }
  for (const { call, loc } of calls) lines.push({ code: `void (${print(call)});`, loc, what: call.fn });
  // each React component as it is called: its props (events as onX, class as className) against its own declared props
  const reactNames = new Set((doc.imports || []).filter((def) => def.kind === UseKind.React).flatMap((def) => def.names));
  if (reactTypes) for (const node of Object.values(doc.nodes || {})) {
    const component = node.props?.component || '';
    if (node.type !== Nt.Custom || !reactNames.has(component.split('.')[0])) continue;
    const given = [...Object.keys(node.props.inputs || {}), ...Object.keys(node.props.on || {}).map((event) => 'on' + event.replace(/(^|-)(\w)/g, (_m: string, _d: string, c: string) => c.toUpperCase())), ...(node.props.class?.length ? ['className'] : []), ...(node.children?.length ? ['children'] : [])];
    lines.push({ code: `{ const __props: import('react').ComponentProps<typeof ${component}> = { ${given.map((key) => `${JSON.stringify(key)}: ${ANY}`).join(', ')} }; void __props; }`, loc: node.loc ?? null, what: component });
  }
  // each Custom written in TypeScript (src/components/Name.ts), as it is called: its inputs and its events against the
  // types of its own `mount(el, inputs, on)`
  for (const node of Object.values(doc.nodes || {})) {
    const component = node.props?.component || '';
    const host = join(appRoot, 'src', 'components', component + '.ts');
    if (node.type !== Nt.Custom || !component || reactNames.has(component.split('.')[0]) || !existsSync(host)) continue;
    if (!EXPORTED_MOUNT.test(readFileSync(host, 'utf8'))) continue;   // a plain `function mount` works too, but has no types to read from outside
    const mount = `__mount_${node.id}`;
    const inputs = Object.keys(node.props.inputs || {}).map((key) => `${JSON.stringify(key)}: ${ANY}`).join(', ');
    const events = Object.keys(node.props.on || {}).map((key) => `${JSON.stringify(key)}: ${ANY}`).join(', ');
    lines.push({ code: `import type { mount as ${mount} } from ${JSON.stringify(host)};`, loc: null, what: '' });
    lines.push({ code: `{ const __in: Parameters<typeof ${mount}>[1] = { ${inputs} }; const __on: NonNullable<Parameters<typeof ${mount}>[2]> = { ${events} }; void __in; void __on; }`, loc: node.loc ?? null, what: `${CUSTOM_PREFIX}${component}` });
  }
  return lines;
}

/** TypeScript's word on every page's calls into its packages, by page file. Empty when TypeScript is not there. */
export function packageTypeDiagnostics(pages: Array<{ file: string; doc: Doc }>, appRoot: string, theme?: ThemeRaw): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  const oracle = typeOracle(appRoot);
  if (!oracle || !pages.length) return out;
  const sources = new Map<string, { lines: Line[]; page: string }>();
  for (const { file, doc } of pages) {
    const lines = pageSource(doc, appRoot, theme);
    if (lines.length > 1) sources.set(join(dirname(file), '__muten_types.ts'), { lines, page: file });
  }
  if (!sources.size) return out;
  let findings: TypeFinding[];
  try { findings = oracle.check(new Map([...sources].map(([path, { lines }]) => [path, lines.map((line) => line.code).join('\n')]))); }
  catch { return out; }   // its word is a bonus: never what breaks check
  for (const finding of findings) {
    const source = sources.get(finding.file);
    if (!source || !REPORTED.has(finding.code)) continue;
    const line = source.lines[finding.line];
    if (!line?.what) continue;
    const text = finding.code === MISSING_MODULE ? `"${line.what}" is not installed: \`npm i ${line.what}\`` : line.what.startsWith(CUSTOM_PREFIX) ? `${line.what.slice(CUSTOM_PREFIX.length)}: ${finding.message} (the types of its mount in src/components/${line.what.slice(CUSTOM_PREFIX.length)}.ts say so)` : PROP_CODES.has(finding.code) ? `${line.what}: ${finding.message} (its own props say so)` : `${line.what}: ${finding.message} (the package's own types say so)`;
    const found = out.get(source.page) ?? [];
    found.push({ code: line.what.startsWith(CUSTOM_PREFIX) ? 'custom-type' : 'package-type', severity: 'error', message: text, loc: line.loc, suggestion: null });
    out.set(source.page, found);
  }
  return out;
}
