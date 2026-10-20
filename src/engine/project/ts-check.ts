// ts-check: a page's calls into its packages, checked by TypeScript itself against the packages' own types:
//   stripe.elemnts(…)            Property 'elemnts' does not exist on type 'Stripe'. Did you mean 'elements'?
//   z.string().emial()           a step of a chain that the package does not have
//   dayjs(x).format("D", 2)      how many values a method takes
// muten writes those calls into one TypeScript file per page (in memory, next to the page so its node_modules resolve),
// with muten's own values as `any` (they are checked by muten), and reports what would throw at run time: a member that
// does not exist, a call with the wrong number of values, `new` on what is not a class, a name the package lacks.
// TypeScript comes from the app or from muten itself; without it, nothing changes.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as TS from 'typescript';
import { Ek, StOp, THEME_REF, LIVE_CHANGE } from '#engine/shared/vocab.js';
import { foreignNames, callValues } from '#engine/ir/calls.js';
import { themeValue } from '#engine/style/theme-ref.js';
import { getOrder } from '#engine/ir/refs.js';
import type { CallExpr, Diagnostic, Doc, Expr, Loc, Stmt, ThemeRaw } from '#engine/shared/types.js';

const ANY = '__mutenValue';
// what would throw at run time; a value of another type is muten's to check, not TypeScript's
const REPORTED = new Set([2339, 2551, 2554, 2555, 2349, 2351, 7009, 2305, 2614, 2724, 2307]);
const OWN_FILE = /^(\.|~\/|\/)/;
const MISSING_MODULE = 2307;

/** TypeScript with its JavaScript API, from the app or from muten; undefined when neither has one. (TypeScript 7, the
 *  native one, has no JavaScript API yet: an app on it gets muten's own.) */
export function loadTypeScript(appRoot: string): typeof TS | undefined {
  for (const base of [join(appRoot, 'package.json'), import.meta.url]) {
    try {
      const loaded: typeof TS = createRequire(base)('typescript');
      if (typeof loaded.createProgram === 'function' && loaded.ScriptTarget) return loaded;
    } catch { /* the next place */ }
  }
  return undefined;
}

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
  for (const [index, def] of (doc.imports || []).entries()) {
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
  return lines;
}

/** TypeScript's word on every page's calls into its packages, by page file. Empty when TypeScript is not there. */
export function packageTypeDiagnostics(pages: Array<{ file: string; doc: Doc }>, appRoot: string, theme?: ThemeRaw): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  const ts = loadTypeScript(appRoot);
  if (!ts || !pages.length) return out;
  try { return askTypeScript(ts, pages, appRoot, theme); } catch { return out; }   // its word is a bonus: never what breaks check
}

function askTypeScript(ts: typeof TS, pages: Array<{ file: string; doc: Doc }>, appRoot: string, theme: ThemeRaw | undefined): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  const sources = new Map<string, { lines: Line[]; page: string }>();
  for (const { file, doc } of pages) {
    const lines = pageSource(doc, appRoot, theme);
    if (lines.length > 1) sources.set(join(dirname(file), '__muten_types.ts'), { lines, page: file });
  }
  if (!sources.size) return out;
  const options: TS.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true, strict: false, allowImportingTsExtensions: true, esModuleInterop: true, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [] };
  const host = ts.createCompilerHost(options);
  const text = (path: string): string | undefined => { const page = sources.get(path); return page ? page.lines.map((line) => line.code).join('\n') : undefined; };
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path: string): boolean => sources.has(path) || ts.sys.fileExists(path);
  host.readFile = (path: string): string | undefined => text(path) ?? readFile(path);
  host.getSourceFile = (path, version, onError, create) => { const own = text(path); return own !== undefined ? ts.createSourceFile(path, own, version) : getSourceFile(path, version, onError, create); };
  const program = ts.createProgram([...sources.keys()], options, host);
  for (const [path, { lines, page }] of sources) {
    const found: Diagnostic[] = [];
    const sourceFile = program.getSourceFile(path);
    if (!sourceFile) continue;
    for (const d of [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]) {
      if (!REPORTED.has(d.code) || d.start === undefined) continue;
      const line = lines[sourceFile.getLineAndCharacterOfPosition(d.start).line];
      if (!line?.what) continue;
      const text = d.code === MISSING_MODULE ? `"${line.what}" is not installed: \`npm i ${line.what}\`` : `${line.what}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')} (the package's own types say so)`;
      found.push({ code: 'package-type', severity: 'error', message: text, loc: line.loc, suggestion: null });
    }
    if (found.length) out.set(page, found);
  }
  return out;
}
