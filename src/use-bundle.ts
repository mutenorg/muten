// use-bundle: the `use` functions of a page, bundled for the outputs with no bundler (`muten build`'s standalone pages
// and its build-time pre-render). Those pages called `t(…)` with nothing defining it: the build only warned, and the
// page threw «t is not defined» in the browser. Now each page carries its own functions, bundled by esbuild exactly as
// `muten bundle` would (npm packages, `~/` for src/), as one script that leaves them in scope.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import type { ImportDef } from '#engine/shared/types.js';
import { envDefines } from '#engine/project/env.js';
import { CUSTOM_MODULE, UseKind } from '#engine/shared/vocab.js';
import { packageBindings, OWN_FILE } from '#engine/compile/foreign.js';
import { nativeWebOptions } from '#engine/project/native-web.js';

const GLOBAL = '__muten_use';
const CUSTOM_GLOBAL = '__muten_custom';

/** JS that leaves in scope what a page's `use` lines bring in: its functions by name, and for components from npm what
 *  mounting them needs (a Web Component's registration, a widget's `__custom_<Name>`, a React component and React's two
 *  calls), or '' when the page uses nothing. */
export async function bundleUses(imports: ImportDef[], pageFile: string, appRoot: string): Promise<string> {
  if (!imports.length) return '';
  const lines: string[] = []; const names: string[] = [];
  for (const [index, def] of imports.entries()) {
    if (def.script) continue;   // a global its <script> leaves: the page makes it (foreign.ts scriptGlobals)
    const from = JSON.stringify(def.from); const name = def.names[0] || '';
    if (def.kind === UseKind.Element) lines.push(`import ${from};`);
    else if (def.kind === UseKind.Widget) { lines.push(`export { mount as __custom_${name} } from ${from};`); names.push(`__custom_${name}`); }
    else if (def.kind === UseKind.React) { lines.push(`import * as __ns_${name} from ${from};`, `export const __react_ns_${name} = __ns_${name};`); names.push(`__react_ns_${name}`); }
    else { lines.push(...(OWN_FILE.test(def.from) ? [`export { ${def.names.join(', ')} } from ${from};`] : packageBindings(def, index, 'export const'))); names.push(...def.names); }
  }
  if (imports.some((def) => def.kind === UseKind.React)) { lines.push("export { createElement as __react_h } from 'react';", "export { createRoot as __react_root } from 'react-dom/client';"); names.push('__react_h', '__react_root'); }
  const nativeWeb = nativeWebOptions(appRoot);
  const result = await esbuild.build({
    stdin: { contents: lines.join('\n'), resolveDir: dirname(pageFile), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: GLOBAL, platform: 'browser', target: 'es2022', minify: true,
    ...nativeWeb, alias: { '~': join(appRoot, 'src'), ...nativeWeb.alias },   // React Native libraries on the web (native-web.ts)
    define: { ...envDefines(appRoot), 'process.env.NODE_ENV': '"production"', ...nativeWeb.define },   // `import.meta.env.MUTEN_API` (env.ts); React reads NODE_ENV
    logLevel: 'silent',
  });
  const code = result.outputFiles[0]?.text ?? '';
  return names.length ? `${code}\nconst { ${names.join(', ')} } = ${GLOBAL};` : code;
}

// A Custom file that imports things (an npm widget, its own helpers) cannot be inlined as text: it travels as
// CUSTOM_MODULE + its path, and the page imports its `mount`. Without imports it is inlined as always.
const TOP_LEVEL_IMPORT = /^[ \t]*import[ \t]+[\w*{"']/m;
export function customSource(file: string): string {
  const source = readFileSync(file, 'utf8');
  return TOP_LEVEL_IMPORT.test(source) ? CUSTOM_MODULE + file : source;
}

/** For the outputs with no bundler: each module-style Custom bundled, its `mount` left as `__custom_<Name>`. */
export async function bundleCustoms(components: { [name: string]: string }, appRoot: string): Promise<string> {
  const modules = Object.entries(components).filter(([, src]) => src.startsWith(CUSTOM_MODULE));
  if (!modules.length) return '';
  const entry = modules.map(([name, src]) => `export { mount as ${name} } from ${JSON.stringify(src.slice(CUSTOM_MODULE.length))};`).join('\n');
  const result = await esbuild.build({
    stdin: { contents: entry, resolveDir: appRoot, loader: 'js' },
    bundle: true, write: false, format: 'iife', globalName: CUSTOM_GLOBAL, platform: 'browser', target: 'es2022', minify: true,
    alias: { '~': join(appRoot, 'src') }, define: envDefines(appRoot), logLevel: 'silent',
  });
  return `${result.outputFiles[0]?.text ?? ''}\n${modules.map(([name]) => `const __custom_${name} = ${CUSTOM_GLOBAL}.${name};`).join('\n')}`;
}
