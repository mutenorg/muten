// honest-types: the engine's type rules, enforced instead of remembered (src/engine/README.md). Walks every
// src/**/*.ts with the TypeScript parser and fails on what silences the compiler instead of informing it:
//   · `x as T` and `<T>x`   a cast that tells the compiler what to believe
//   · `x!`                   a non-null assertion
//   · `any`                  a type that turns checking off
//   · @ts-ignore / @ts-expect-error / @ts-nocheck
//   · a file over 500 lines (src/engine/README.md: split it into single-purpose pieces)
// `import * as ns` and `export * as ns` are not casts and are left alone. Runs in `npm run build`.
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') && !name.endsWith('.d.ts') ? [full] : [];
});
const MAX_LINES = 500;
const RULES = new Map([
  [ts.SyntaxKind.AsExpression, 'a cast (`as`): type the value honestly, or narrow it with a check'],
  [ts.SyntaxKind.TypeAssertionExpression, 'a cast (`<T>x`): type the value honestly, or narrow it with a check'],
  [ts.SyntaxKind.NonNullExpression, 'a non-null assertion (`!`): handle the missing case'],
  [ts.SyntaxKind.AnyKeyword, '`any`: name the real type'],
]);
const found = [];
for (const file of files(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > MAX_LINES) found.push(`${relative(root, file)}  ${lines} lines: split it into single-purpose pieces (max ${MAX_LINES})`);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node, why) => { const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source)); found.push(`${relative(root, file)}:${line + 1}:${character + 1}  ${why}`); };
  const visit = (node) => { const why = RULES.get(node.kind); if (why) report(node, why); ts.forEachChild(node, visit); };
  visit(source);
  for (const match of text.matchAll(/@ts-(ignore|expect-error|nocheck)/g)) {
    const { line } = source.getLineAndCharacterOfPosition(match.index);
    found.push(`${relative(root, file)}:${line + 1}  @ts-${match[1]}: fix the type instead of silencing it`);
  }
}
if (found.length) { console.error(`✖ ${found.length} place(s) silence the type checker:\n  ` + found.join('\n  ')); process.exit(1); }
console.log(`✓ honest types: no casts, non-null assertions, any or ts-ignore in src/, no file over ${MAX_LINES} lines`);
