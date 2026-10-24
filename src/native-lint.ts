// native-lint: `muten check --native`, what will not reach the phone said while the app is written, each at its place:
// the CSS line (src/styles.css:207), the node in its page (src/pages/hoy/hoy.muten:68), or the app's root. Two kinds:
//   ✖ does not reach the phone (with what to write instead), ~ reaches it with a stated difference.
// The decisions are the native CSS profile (engine/native/profile.ts) and the coverage table (engine/native/coverage.ts),
// the same ones the compiler uses: what check says is exactly what `muten native` will do.
import { join, relative } from 'node:path';
import { loadModel } from './esbuild-muten.js';
import { load } from '#engine/project/load.js';
import { readCss } from '#engine/native/css.js';
import { nativeLooks } from '#engine/native/styles.js';
import { PRIMITIVES } from '#engine/native/coverage.js';
import { appCss } from './native-project.js';
import type { NativeLevel } from '#engine/shared/types-native.js';

interface NativeFinding { file: string; line?: number; level: NativeLevel; what: string; why: string; pages: string[] }

const MARK: { readonly [level: string]: string } = { none: '✖', approx: '~', exact: '·' };

/** Every native finding of the app, each once, with the pages it shows on. */
export async function nativeFindings(root: string): Promise<NativeFinding[]> {
  const model = await loadModel(root);
  const sheet = readCss(appCss(root));
  const found = new Map<string, NativeFinding>();
  const add = (finding: Omit<NativeFinding, 'pages'>, page: string): void => {
    const key = `${finding.file}:${finding.line}:${finding.what}`;
    const known = found.get(key);
    if (known) { if (!known.pages.includes(page)) known.pages.push(page); } else found.set(key, { ...finding, pages: [page] });
  };
  const styles = join('src', 'styles.css');
  for (const route of model.appIr?.routes || []) {
    const file = join('src', 'pages', route.page, route.page + '.muten');
    const { doc } = await load(join(root, file), model.parts);
    for (const gap of nativeLooks(doc, sheet).gaps) add({ file: gap.line ? styles : file, line: gap.line, level: gap.level ?? 'none', what: gap.what, why: gap.why }, route.page);
    for (const node of Object.values(doc.nodes)) {
      const decision = PRIMITIVES[node.type];
      if (decision && decision.level !== 'exact') add({ file, line: node.loc?.line, level: decision.level, what: node.type, why: decision.note }, route.page);
      for (const event of Object.keys(node.props?.on || {})) add({ file, line: node.loc?.line, level: 'none', what: `on(${event})`, why: 'events and gestures are not on the phone yet' }, route.page);
    }
  }
  return [...found.values()].sort((a, b) => (a.level === b.level ? a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) : a.level === 'none' ? -1 : 1));
}

/** `muten check --native`: the findings, by file and line; JSON for an agent. Warnings: the exit code stays 0. */
export async function nativeLint(root: string, json: boolean): Promise<number> {
  const findings = await nativeFindings(root);
  if (json) { console.log(JSON.stringify({ native: findings }, null, 2)); return 0; }
  const none = findings.filter((finding) => finding.level === 'none').length;
  console.log(`\nnative (React Native): ${none ? `${none} thing(s) do not reach the phone` : 'everything reaches the phone'}${findings.length - none ? `, ${findings.length - none} reach it with a difference` : ''}\n`);
  for (const finding of findings) {
    const where = `${relative(process.cwd(), join(root, finding.file)) || finding.file}${finding.line ? `:${finding.line}` : ''}`;
    console.log(`  ${MARK[finding.level]} ${where}  ${finding.what}\n      ${finding.why}${finding.pages.length > 1 ? `  (${finding.pages.length} pages)` : ''}`);
  }
  return 0;
}
