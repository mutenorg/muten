// native-project: `muten native`, a muten app as an Expo (React Native) app, in .muten/native/ (generated, disposable,
// like dist/). Each page becomes a screen (engine/native/), each route an Expo Router file, each store the same module
// the web loads; muten's signals go in as muten/runtime.js and the drawing kit as muten/native.jsx. Then the check:
// every screen opened and pressed in React Native's own test environment, so a crash stops here and not on a phone.
// The proof of concept of the native target: what it cannot translate yet is said, per page, in the report.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { loadModel } from './esbuild-muten.js';
import { load } from '#engine/project/load.js';
import { compile, compileStore } from '#engine/compile/compile.js';
import { toDoc } from '#engine/ir/flatten.js';
import { dataModule } from '#engine/compile/emit.js';
import { guardJs } from '#engine/compile/guard.js';
import { readCss } from '#engine/native/css.js';
import { POINTS_ONLY, NUMBERS_ONLY, LENGTH_OR_PERCENT } from '#engine/native/profile.js';
import { Fmt, Nt } from '#engine/shared/vocab.js';
import type { NativeReport } from '#engine/shared/types-native.js';
import type { Expr } from '#engine/shared/types.js';
import { nativeAndroid, nativeErrors, nativeScreenshot } from './native-android.js';
import { followLogs, recordError } from './native-errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const KIT = join(here, '..', 'native-kit');
const OUT = join('.muten', 'native');
const SHELL = '__shell';   // the shell's screen module (screens/__shell.jsx): no page can be named so
/** The exit code of a session round (`--regen`) that installed a new package: the session restarts Metro. */
export const RESTART_METRO = 75;
// what the generated app depends on: the versions `npx expo install` picks for Expo SDK 58, all inside Expo Go, so the
// app opens on a phone (Android or iPhone) by scanning a QR, with nothing to build
const DEPENDENCIES: { readonly [name: string]: string } = {
  expo: '~58.0.19', 'expo-router': '~58.0.26', 'expo-image': '~58.0.17', 'expo-linking': '~58.0.14', 'expo-constants': '~58.0.13',
  'expo-status-bar': '~58.0.4', react: '19.3.0', 'react-native': '0.88.0', 'react-native-safe-area-context': '~5.10.1', 'react-native-screens': '~4.30.0',
};
// what the check needs (React Native's own test environment), at the versions SDK 58 asks for
const DEV_DEPENDENCIES: { readonly [name: string]: string } = {
  'jest-expo': '~58.0.12', jest: '^29.7.0', '@react-native/jest-preset': '^0.88.0', '@testing-library/react-native': '^14.1.0', 'react-test-renderer': '19.3.0',
};
// jest-expo's own list of packages to transform, plus FormatJS (its polyfills are ES modules, which Metro reads and Jest does not)
const STORAGE = { 'expo-sqlite': '~58.0.14' };   // the phone's localStorage, only for an app that persists
const SVG = { 'react-native-svg': '15.16.0' };      // icons (and later charts and Svg), only for an app that shows them
const MOTION = { 'react-native-reanimated': '4.7.1', 'react-native-worklets': '0.13.0' };   // CSS animations and transitions
const JEST = { preset: 'jest-expo', setupFiles: ['<rootDir>/muten-hermes.js'], transformIgnorePatterns: ['/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@formatjs))', '/node_modules/react-native-reanimated/plugin/', '/node_modules/@react-native/babel-preset/'], moduleNameMapper: { '^virtual:muten/runtime$': '<rootDir>/muten/runtime.js', '^virtual:muten/data$': '<rootDir>/muten/data.js', '^virtual:muten/store/(.*)$': '<rootDir>/stores/$1.js', '\\.svg$': '<rootDir>/muten/asset-stub.js' } };
const SAMPLE_PARAM = '1';
// Hermes (the phone's JavaScript) has no Intl.RelativeTimeFormat, Intl.PluralRules or Intl.Locale: a screen whose code
// asks for one gets FormatJS's polyfills, in the order FormatJS needs them, with the data of the app's languages
// (muten-hermes.js makes the check lack them too, so a screen that needs one and goes without fails before the phone)
const INTL_POLYFILLS: ReadonlyArray<{ needs: RegExp; pkg: string; version: string; data: boolean }> = [
  { needs: /Intl\.(Locale|PluralRules|RelativeTimeFormat)\b/, pkg: '@formatjs/intl-locale', version: '^5.3.12', data: false },
  { needs: /Intl\.(PluralRules|RelativeTimeFormat)\b/, pkg: '@formatjs/intl-pluralrules', version: '^6.3.16', data: true },
  { needs: /Intl\.RelativeTimeFormat\b/, pkg: '@formatjs/intl-relativetimeformat', version: '^12.3.16', data: true },
];
const PRESSABLE = new Set<string>([Nt.Button, Nt.Link, Nt.Checkbox]);   // a value for each route param while the check opens a screen
// the runtime symbols a screen may import, from muten's own modules: the pure ones (no DOM, nothing that runs as it loads)
const RUNTIME_ENTRY = `export { signal, computed, effect, untrack, root, onCleanup, scope } from './runtime-signals.js';
export { __t, __lang, __langUse, __langInit, __langList, __langLikely } from './runtime-lang.js';
export { __eq } from './runtime-blocks.js';
export { __rowKey } from './runtime-key.js';
export { __has, __id } from './runtime-pure.js';
`;
const run = (command: string, args: string[], cwd: string, quiet = false): { ok: boolean; said: string } => {
  const program = process.platform === 'win32' ? `${command}.cmd` : command;
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  return { ok: result.status === 0, said: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

/** `/product/:id` → app/product/[id].jsx; `/` → app/index.jsx. */
function routeFile(url: string): string {
  const parts = url.replace(/^\//, '').split('/').filter(Boolean).map((part) => (part.startsWith(':') ? `[${part.slice(1)}]` : part));
  return join('app', ...(parts.length ? parts : ['index'])) + '.jsx';
}

/** The app's stylesheet with its local @imports inlined (Tailwind and packages are not read by the native output). */
export function appCss(root: string): string {
  const read = (file: string, seen: Set<string>): string => {
    if (seen.has(file) || !existsSync(file)) return '';
    seen.add(file);
    return readFileSync(file, 'utf8').replace(/@import\s+["'](\.[^"']+)["'][^;]*;/g, (_whole, spec: string) => read(join(dirname(file), spec), seen));
  };
  return read(join(root, 'src', 'styles.css'), new Set());
}

/** Writes the Expo app; returns its folder and each page's report. */
/** A guarded route: its screen only while the guard holds; when it stops holding (a login, a logout), the route
 *  sends the person on, as the web app does. The guard is the same JavaScript the web build checks (guardJs). */
function guardedRoute(guard: Expr, redirect: string, screen: string, kit: string): string {
  const domains = new Set<string>();
  const check = guardJs(guard, domains);
  const stores = [...domains].map((domain) => `import * as __store_${domain} from 'virtual:muten/store/${domain}';`).join('\n');
  return `import Screen from '${screen}';\nimport { Guarded } from '${kit}';\n${stores}\n\nexport default function Route() {\n  return <Guarded allow={() => ${check}} redirect={${JSON.stringify(redirect)}}><Screen /></Guarded>;\n}\n`;
}

/** What the native output does not do yet at the scale of the whole app: said, never dropped in silence. */
function appGaps(model: Awaited<ReturnType<typeof loadModel>>): string[] {
  const inLayouts = (model.appIr?.routes || []).filter((route) => route.layout).map((route) => route.url);
  return inLayouts.length ? [`layouts: ${inLayouts.join(', ')} show without their layout (\`-> page in name\` is not drawn on the phone yet)`] : [];
}

export async function nativeProject(root: string): Promise<{ dir: string; reports: Array<{ page: string; report: NativeReport }>; app: string[] }> {
  const model = await loadModel(root);
  const dir = join(root, OUT);
  for (const sub of ['app', 'screens', 'stores', 'muten']) mkdirSync(join(dir, sub), { recursive: true });
  const sheet = readCss(appCss(root));
  const reports: Array<{ page: string; report: NativeReport }> = [];
  const screens: string[] = [];
  const codes: string[] = [];
  const stores: string[] = [];
  const kept = (code: string): string => { stores.push(code); return code; };
  // only what changed is written: the running app reloads just those screens, and Metro never sees its own config
  // "change" (which would ask for a restart)
  const written = new Set<string>();
  const write = (path: string, text: string | Buffer): void => {
    const file = join(dir, path);
    written.add(file);
    if (existsSync(file) && readFileSync(file).equals(Buffer.from(text))) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const mirror = (from: string, to: string): void => {
    for (const name of existsSync(from) ? readdirSync(from) : []) {
      const source = join(from, name);
      if (statSync(source).isDirectory()) mirror(source, join(to, name)); else write(join(to, name), readFileSync(source));
    }
  };

  for (const route of model.appIr?.routes || []) {
    const file = join(root, 'src', 'pages', route.page, route.page + '.muten');
    const { doc, data, sources } = await load(file, model.parts);
    const report: NativeReport = { nodes: 0, translated: 0, gaps: [] };
    const code = compile(doc, data, '', {}, sources, { format: Fmt.Native, native: { sheet, report }, stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {}, translations: model.translations, themeValues: model.themeValues, iconResolver: model.iconResolver });
    write(join('screens', route.page + '.jsx'), code);
    codes.push(code);
    const target = routeFile(route.url);
    const from = (path: string): string => relative(dirname(join(dir, target)), join(dir, path)).replace(/\\/g, '/');
    write(target, route.guard ? guardedRoute(route.guard, route.redirect || '/', from(join('screens', route.page)), from(join('muten', 'native'))) : `export { default } from '${from(join('screens', route.page))}';\n`);
    reports.push({ page: route.page, report });
    const params = Object.fromEntries((doc.params || []).map((name) => [name, SAMPLE_PARAM]));
    // at least the pressables written outside a list: the check fails if it finds fewer (it pressed nothing, so it proved nothing)
    const listed = new Set<string>();
    const mark = (id: string, inList: boolean): void => { const node = doc.nodes[id]; if (inList) listed.add(id); for (const kid of node.children || []) mark(kid, inList || node.type === Nt.Each || node.type === Nt.When); };
    if (doc.rootId) mark(doc.rootId, false);
    const pressable = Object.entries(doc.nodes).filter(([id, node]) => !listed.has(id) && PRESSABLE.has(node.type)).length;
    screens.push(`  [${JSON.stringify(route.page)}, ${JSON.stringify(params)}, () => require('./screens/${route.page}').default, ${pressable}],`);
  }
  // the app's frame (`shell { … slot }` in app.muten): compiled like a page, its slot the screens' navigator (tree.ts),
  // drawn around every route by app/_layout.jsx
  const shellTree = model.appIr?.shell;
  if (shellTree) {
    const doc = toDoc({ ...(model.appIr || {}), screen: 'shell', entities: {}, state: {}, actions: {}, tree: shellTree });
    const report: NativeReport = { nodes: 0, translated: 0, gaps: [] };
    const code = compile(doc, {}, '', {}, {}, { format: Fmt.Native, native: { sheet, report }, stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {}, translations: model.translations, themeValues: model.themeValues, iconResolver: model.iconResolver });
    write(join('screens', `${SHELL}.jsx`), code);
    codes.push(code);
    reports.push({ page: 'shell', report });
    screens.push(`  ["shell", {}, () => require('./screens/${SHELL}').default, 0],`);
  }
  for (const [domain, ir] of Object.entries(model.slices)) {
    write(join('stores', domain + '.js'), kept(compileStore({ state: ir.state || {}, gets: ir.gets || {}, fns: ir.fns || {}, actions: ir.actions || {}, effects: ir.effects || [], entities: ir.entities || {}, imports: ir.imports || [], domain, dev: false, api: model.appIr?.api || {}, stores: model.store.storesMeta, translations: model.translations, themeValues: model.themeValues }, ir.mock || {}, ir.sources || {})));
  }
  // what the phone's JavaScript lacks and the screens ask for: its polyfills, loaded before any screen (muten/intl.js)
  const screenCode = codes.join('\n');
  // `persist` reads and writes localStorage, which a phone does not have: Expo's, kept in SQLite, is installed before
  // any store loads (muten/storage.js, imported first by the kit), so the same code keeps a session across launches
  const keeps = /localStorage/.test(screenCode + stores.join('\n'));
  write(join('muten', 'storage.js'), keeps ? `// Generated by muten: a localStorage on the phone, kept in SQLite, for \`persist\`.\nimport 'expo-sqlite/localStorage/install';\n` : '// Generated by muten: no `persist` in this app, so no storage.\n');
  const languages = [...new Set([...Object.keys(model.translations || {}), 'en'])];
  const polyfills = INTL_POLYFILLS.filter((one) => one.needs.test(screenCode));
  const intl = polyfills.flatMap((one) => [`import '${one.pkg}/polyfill.js';`, ...(one.data ? languages.map((code) => `import '${one.pkg}/locale-data/${code}.js';`) : [])]);
  write(join('muten', 'intl.js'), `// Generated by muten: what Hermes lacks of Intl and these screens use, polyfilled (nothing when they use none).\n${intl.join('\n')}\n`);
  const runtime = await esbuild.build({ stdin: { contents: RUNTIME_ENTRY, resolveDir: here, loader: 'js' }, bundle: true, format: 'esm', write: false, platform: 'neutral', minify: false, define: { __MUTEN_DEV__: 'false' }, logLevel: 'silent' });
  write(join('muten', 'runtime.js'), runtime.outputFiles[0]?.text ?? '');
  write(join('muten', 'data.js'), dataModule());   // queries, sources and writes: the same data layer the web runs
  write(join('muten', 'native.jsx'), readFileSync(join(KIT, 'native.jsx')));
  write('muten-check.test.jsx', readFileSync(join(KIT, 'muten-check.test.jsx')));
  write('muten-hermes.js', readFileSync(join(KIT, 'muten-hermes.js')));
  // the app's public/ folder, inside the app: a picture named by a fixed path (`Image "/logo.svg"`) is packed with it
  mirror(join(root, 'public'), 'public');
  write(join('muten', 'asset-stub.js'), 'module.exports = 1;\n');
  write('muten-style-rules.js', `// Generated by muten (engine/native/profile.ts): what each style prop takes on the phone, for the check.\nexport const POINTS_ONLY = ${JSON.stringify(POINTS_ONLY)};\nexport const NUMBERS_ONLY = ${JSON.stringify(NUMBERS_ONLY)};\nexport const LENGTH_OR_PERCENT = ${JSON.stringify(LENGTH_OR_PERCENT)};\n`);
  write('muten-screens.js', `// Generated by muten: the screens the check opens, with a value for each route param.\nexport default [\n${screens.join('\n')}\n];\n`);
  const frame = shellTree ? `import Shell from '../screens/${SHELL}';\n` : `import { Stack } from 'expo-router';\n`;
  write('app/_layout.jsx', `${frame}import { StatusBar } from 'expo-status-bar';\nimport { useTrail } from '../muten/native';\n\nexport default function Layout() {\n  useTrail();\n  return (<><StatusBar style="auto" />${shellTree ? '<Shell />' : '<Stack screenOptions={{ headerShown: false }} />'}</>);\n}\n`);
  const name = (root.split(/[\\/]/).pop() || 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
  write('package.json', JSON.stringify({ name: `muten-native-${name}`, version: '0.0.0', private: true, main: 'expo-router/entry', dependencies: { ...DEPENDENCIES, ...(keeps ? STORAGE : {}), ...(screenCode.includes('<SvgXml') ? SVG : {}), ...(/Animated\.|AnimatedPressable/.test(screenCode) ? MOTION : {}), ...Object.fromEntries(polyfills.map((one) => [one.pkg, one.version])) }, devDependencies: DEV_DEPENDENCIES, scripts: { start: 'expo start', check: 'jest muten-check' }, jest: JEST }, null, 2) + '\n');
  write('app.json', JSON.stringify({ expo: { name, slug: `muten-${name}`, scheme: `muten${name}`, version: '0.0.0', orientation: 'portrait', userInterfaceStyle: 'automatic', plugins: ['expo-router'] } }, null, 2) + '\n');
  // muten's virtual modules, as files of this app: the runtime and every store
  write('metro.config.js', `const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('svg');   // the app's public/ pictures, logos included, travel inside the app
const virtual = { 'virtual:muten/runtime': path.join(__dirname, 'muten', 'runtime.js'), 'virtual:muten/data': path.join(__dirname, 'muten', 'data.js') };
config.resolver.resolveRequest = (context, name, platform) => {
  if (virtual[name]) return { type: 'sourceFile', filePath: virtual[name] };
  if (name.startsWith('virtual:muten/store/')) return { type: 'sourceFile', filePath: path.join(__dirname, 'stores', name.slice('virtual:muten/store/'.length) + '.js') };
  return context.resolveRequest(context, name, platform);
};
module.exports = config;
`);
  const app = appGaps(model);
  write('muten-report.json', JSON.stringify({ app, pages: reports }, null, 2) + '\n');
  // what this round did not write is gone from the app (a page removed, a renamed store, a picture deleted)
  const prune = (folder: string): void => {
    for (const name of existsSync(folder) ? readdirSync(folder) : []) {
      const file = join(folder, name);
      if (statSync(file).isDirectory()) prune(file); else if (!written.has(file)) rmSync(file);
    }
  };
  for (const sub of ['app', 'screens', 'stores', 'public']) prune(join(dir, sub));
  return { dir, reports, app };
}

/** The check: every screen opened and every pressable pressed in React Native's test environment. */
/** What the app's package.json asks for, installed (the first time, or when a change brought a new package). */
/** Whether what the app's package.json asks for is all there. */
function isInstalled(dir: string): boolean {
  const wanted = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies || {});
  return existsSync(join(dir, 'node_modules', 'jest-expo')) && wanted.every((pkg) => existsSync(join(dir, 'node_modules', pkg)));
}

function installed(dir: string): boolean {
  if (isInstalled(dir)) return true;
  console.log('\n  · installing what the app needs…');
  // legacy peers: Expo 58 pins react 19.3.0 while the test renderer's react-dom asks for 19.3.1
  if (!run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], dir).ok) return false;
  // the screens were written before the package arrived, and a running Metro may have failed to find it: touched,
  // they are bundled again now that it is there
  const now = new Date();
  for (const name of existsSync(join(dir, 'screens')) ? readdirSync(join(dir, 'screens')) : []) utimesSync(join(dir, 'screens', name), now, now);
  return true;
}

function nativeCheck(dir: string, record = false): boolean {
  const checked = run('npx', ['jest', 'muten-check', '--silent'], dir, true);
  if (checked.ok) return true;
  const lines = checked.said.split('\n').filter((line) => /✕|●|Error|at .*\.(jsx?|tsx?):\d+|^\s*>\s*\d+ \|/.test(line));
  console.error(lines.slice(0, 30).join('\n'));
  // while the app is open, what the check found joins the app's other errors (muten native --errors)
  if (record) for (const line of lines.filter((one) => /●|Error|^\s*\+\s/.test(one)).slice(0, 20)) recordError(dir, 'check', line.trim());
  return false;
}

/** `muten native [dir]`: write the app, install what it needs the first time, check every screen, print the report;
 *  `--start` opens Expo (a QR for Expo Go). */
export async function nativeCommand(root: string, args: string[]): Promise<boolean> {
  const shotAt = args.indexOf('--screenshot');
  if (shotAt >= 0) return nativeScreenshot(args[shotAt + 1] || 'screen.png');   // what the emulator shows, for a person or an agent
  if (args.includes('--compare')) { const { nativeCompare } = await import('./native-compare.js'); return nativeCompare(root, join(root, OUT), args); }   // the phone next to the web, route by route
  if (args.includes('--logs')) return followLogs(join(root, OUT));   // the open session's whole log, live, for a person
  if (args.includes('--errors')) return nativeErrors(join(root, OUT));   // the running app's errors, both sides, and its screen
  if (args.includes('--regen')) {   // a round of the open session (native-android.ts): write, check, and say only what failed
    const { dir } = await nativeProject(root);
    const arriving = !isInstalled(dir);
    const ok = installed(dir) && nativeCheck(dir, true);
    console.log(ok ? '  ✓ written and checked: the phone reloads what changed' : '  ✖ the check failed: muten native --errors');
    // a new package may bring a Babel plugin (Reanimated's worklets), which Metro reads only when it starts: the open
    // session restarts Metro, with its cache cleared (native-android.ts reads this exit code)
    if (arriving && ok) { console.log('  · a new package: Metro starts again, with a clean cache'); process.exitCode = RESTART_METRO; }
    return ok;
  }
  const { dir, reports, app } = await nativeProject(root);
  console.log(`✓ ${relative(process.cwd(), dir) || dir}: an Expo app from ${reports.length} page(s)\n`);
  if (app.length) console.log(`  the app:\n${app.map((gap) => `    ! ${gap}`).join('\n')}\n`);
  for (const { page, report } of reports) {
    console.log(`  ${page}: ${report.translated} of ${report.nodes} nodes drawn natively`);
    for (const gap of report.gaps.slice(0, 12)) console.log(`    · ${gap.what}${gap.count > 1 ? ` ×${gap.count}` : ''}: ${gap.why}`);
  }
  if (!installed(dir)) return false;
  console.log('\n  · check: every screen opened and every pressable pressed, in React Native\'s test environment…');
  if (!nativeCheck(dir)) { console.error('\n  ✖ a screen crashes in React Native: it would crash on the phone too'); return false; }
  console.log(`  ✓ ${reports.length} screen(s) open and respond`);
  if (args.includes('--android')) return nativeAndroid(dir, root);   // the emulator, set up and booted by muten, with the app open on it
  if (args.includes('--start')) run('npx', ['expo', 'start'], dir);
  else console.log(`\n  open it: cd ${relative(process.cwd(), dir) || dir} && npx expo start   (scan the QR with Expo Go, on Android or iPhone)\n`);
  return true;
}
