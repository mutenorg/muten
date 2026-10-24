// cli-help: what `muten` alone (or `muten help`) says: every command, one line each, and the keys `muten dev` listens to.

/** Each command and what it does, in the order one meets them. */
export const COMMANDS: ReadonlyArray<[string, string]> = [
  ['dev [dir]', 'the app on this machine, rebuilt on every save (--host: open it to a phone on the wifi)'],
  ['check [dir]', 'every finding, at its file and line (--json for an agent, --fix to apply the sure ones, --changed, --watch)'],
  ['explain <code>', 'what a finding means, how to fix it, the slip next to its fix'],
  ['fmt [dir]', 'one shape for every .muten and .store file; only whitespace moves (--check: say, do not write)'],
  ['test [dir]', 'the .test files, in a headless browser, on mock data (--only=name)'],
  ['bundle [dir]', 'the production build: per-route chunks, pruned CSS, a size report (--sourcemap)'],
  ['build [dir]', 'every route written out as HTML with no JS (--url=https://… for absolute sitemap and robots)'],
  ['map [dir]', 'app.map.json: the app graph an agent reads first'],
  ['config --schema', "muten.config's blocks, keys and values as JSON (for the editor and an agent)"],
  ['upgrade [dir]', 'the muten this app has against the one published, and the line that moves it'],
  ['doctor [dir]', 'everything the app needs, looked at once: Node, muten, config, check, ports, Chrome, Android'],
  ['report [dir]', 'what a muten bug report needs, written to .muten/report.md (versions, packages, check, last error); sends nothing'],
  ['new page|store|app <name>', 'the structure of a page or a store, to fill in'],
  ['add <name>', 'a muten plugin (enabled) · any npm package (installed, checked, weighed, its use line) · PascalCase: a registry component'],
  ['android [dir]', 'the .apk (--build), and whether this machine can build it (--install sets it up)'],
];

/** The keys `muten dev` listens to in a terminal. */
export const DEV_KEYS: ReadonlyArray<[string, string]> = [
  ['o', 'open the app in the browser'],
  ['c', 'muten check'],
  ['h', 'these keys'],
  ['q', 'quit'],
];

const table = (rows: ReadonlyArray<[string, string]>, width: number): string => rows.map(([name, what]) => `  ${name.padEnd(width)}  ${what}`).join('\n');

export function helpText(): string {
  return `muten <command> [dir]\n\n${table(COMMANDS, 26)}\n\nin muten dev:\n${table(DEV_KEYS, 26)}\n\nto create an app:  npm create muten@latest <dir>`;
}

export function devKeysText(): string { return table(DEV_KEYS, 2); }
