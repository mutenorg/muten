// type-oracle: the ONE place muten talks to TypeScript. Everything that wants TypeScript's word (a page's calls into its
// packages today, a page's `fn` bodies tomorrow) hands it a set of virtual files and gets back plain findings: file,
// position, code, text. Nothing else in muten imports TypeScript, so the compiler behind this can change without the
// rest noticing:
//   · today: the TypeScript 6 API, from the app, from muten, or from `@typescript/typescript6` (what an app on
//     TypeScript 7 still has: 7.0 ships no JavaScript API and `require("typescript")` there only says its version);
//   · when TypeScript 7's own API is stable, a second implementation behind the same `check`.
// One oracle per app, kept for the life of the process: `muten dev` and repeated checks reuse the previous program, so
// only the first check pays for loading the compiler and the libraries.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as TS from 'typescript';

/** One thing TypeScript says about one virtual file. `line` and `col` are 0-based, as TypeScript counts them. */
export interface TypeFinding { file: string; line: number; col: number; code: number; message: string }

/** What a package exports, by what its types say each name is. */
export interface PackageExports { components: string[]; functions: string[]; callable: boolean }

export interface TypeOracle {
  /** TypeScript's syntactic and semantic findings on each of `files` (path → text); real files resolve from disk. */
  check(files: ReadonlyMap<string, string>): TypeFinding[];
  /** The React components and the functions package `name` exports, resolved from `fromDir` (empty without types). */
  exportsOf(fromDir: string, name: string): PackageExports;
}

// where an app's TypeScript can come from, first match wins: its own, muten's, then the TypeScript 6 compatibility
// package an app on TypeScript 7 installs for tools that need the API
const MODULES = ['typescript', '@typescript/typescript6'];
const OPTIONS = (ts: typeof TS): TS.CompilerOptions => ({
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true, skipLibCheck: true, strict: false, allowImportingTsExtensions: true, esModuleInterop: true,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: [],
});

// what a React component's type looks like: a call that returns JSX, or one of React's own component types
const COMPONENT = /JSX\.Element|ReactElement|ReactNode|ForwardRefExoticComponent|MemoExoticComponent|NamedExoticComponent|ComponentType|FunctionComponent|\bFC</;

const oracles = new Map<string, TypeOracle | null>();

/** TypeScript with its JavaScript API, or undefined when the app and muten have none. */
export function loadTypeScript(appRoot: string): typeof TS | undefined {
  for (const base of [join(appRoot, 'package.json'), import.meta.url]) {
    for (const name of MODULES) {
      try {
        const loaded: typeof TS = createRequire(base)(name);
        if (typeof loaded.createProgram === 'function' && loaded.ScriptTarget) return loaded;
      } catch { /* the next place */ }
    }
  }
  return undefined;
}

/** The app's oracle, made once per process; undefined when there is no TypeScript to ask. */
export function typeOracle(appRoot: string): TypeOracle | undefined {
  if (!oracles.has(appRoot)) {
    const ts = loadTypeScript(appRoot);
    oracles.set(appRoot, ts ? programOracle(ts) : null);
  }
  return oracles.get(appRoot) ?? undefined;
}

// the TypeScript 6 API: a program over the virtual files, each new one built on the last so unchanged files and the
// libraries are not parsed again
function programOracle(ts: typeof TS): TypeOracle {
  const options = OPTIONS(ts);
  let previous: TS.Program | undefined;
  const programOver = (files: ReadonlyMap<string, string>): TS.Program => {
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (path: string): boolean => files.has(path) || ts.sys.fileExists(path);
    host.readFile = (path: string): string | undefined => files.get(path) ?? readFile(path);
    host.getSourceFile = (path, version, onError, create) => {
      const own = files.get(path);
      return own !== undefined ? ts.createSourceFile(path, own, version) : getSourceFile(path, version, onError, create);
    };
    previous = ts.createProgram([...files.keys()], options, host, previous);
    return previous;
  };
  return {
    check(files) {
      const program = programOver(files);
      const out: TypeFinding[] = [];
      for (const path of files.keys()) {
        const sourceFile = program.getSourceFile(path);
        if (!sourceFile) continue;
        for (const d of [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)]) {
          if (d.start === undefined) continue;
          const at = sourceFile.getLineAndCharacterOfPosition(d.start);
          out.push({ file: path, line: at.line, col: at.character, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
        }
      }
      return out;
    },
    exportsOf(fromDir, name) {
      const out: PackageExports = { components: [], functions: [], callable: false };
      const path = join(fromDir, '__muten_exports.ts');
      const program = programOver(new Map([[path, `import * as probe from ${JSON.stringify(name)};\nimport main from ${JSON.stringify(name)};\n`]]));
      const sourceFile = program.getSourceFile(path);
      const declaration = sourceFile?.statements.find(ts.isImportDeclaration);
      if (!sourceFile || !declaration) return out;
      const checker = program.getTypeChecker();
      const moduleSymbol = checker.getSymbolAtLocation(declaration.moduleSpecifier);
      if (!moduleSymbol) return out;
      // the module itself is a function (`export = dayjs`, or a default export that is one): `use dayjs from "dayjs"`
      const main = sourceFile.statements.filter(ts.isImportDeclaration)[1]?.importClause?.name;
      out.callable = !!main && checker.getTypeAtLocation(main).getCallSignatures().length > 0;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const own = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const type = checker.getTypeOfSymbolAtLocation(own, sourceFile);
        const calls = type.getCallSignatures();
        const isComponent = /^[A-Z]/.test(exported.name) && (COMPONENT.test(checker.typeToString(type)) || calls.some((sig) => COMPONENT.test(checker.typeToString(sig.getReturnType()))));
        if (isComponent) out.components.push(exported.name);
        else if (calls.length && /^[a-z]/.test(exported.name) && exported.name !== 'default') out.functions.push(exported.name);
      }
      return out;
    },
  };
}
