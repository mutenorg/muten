// native-errors: every error of a native app in one file, and what muten has learned from each kind. The file
// (`.muten/native/muten-errors.log`) gathers the three sides an error can come from: the app's JavaScript (Metro), the
// phone's native code (Android's log: a refused style turns the screen red and Metro never hears of it), and the check
// muten runs after each regeneration. `muten native --errors` prints it beside a fresh screenshot.
//
// KNOWN is how the native output learns: each entry is an error that already happened, what it means, and what muten
// does now so it does not happen again. An error that matches none is printed as NEW: that is the one to understand
// and turn into a rule (in the compiler, or in the check, which stops it before the phone), then add here.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ERRORS_FILE = 'muten-errors.log';
// everything the open session prints (Metro, Android's errors, each regeneration), for `muten native --logs`: a person
// in their own terminal and an agent reading the file see the same lines
export const SESSION_FILE = 'muten-session.log';
const RED = '\x1b[31m', GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ANSI = /\x1b\[[0-9;]*m/g;

interface KnownError { readonly match: RegExp; readonly means: string; readonly rule: string }

const KNOWN: readonly KnownError[] = [
  { match: /cannot be cast to java\.lang\.Double|Error while updating prop(erty)? '?\w*(Radius|Width|Size|Spacing|Height)/,
    means: 'a style value the phone refuses: a string where Android reads a number (border-radius: 50%, a % font size)',
    rule: 'props.ts translates only to values the phone takes (50% radius → 9999); the check validates every drawn style (muten-style-rules.js)' },
  { match: /Expected URL scheme 'http' or 'https'|no scheme was found for \//,
    means: 'a picture named by a path of the web app (/logo.svg): the phone has no web server to ask',
    rule: 'an Image with a fixed /path is packed from public/ with require()' },
  { match: /window\.addEventListener is not a function|document is not defined|window is not defined/,
    means: 'browser-only code reached the phone (the DOM does not exist there)',
    rule: 'the native runtime is built from the pure exports only (runtime-pure.ts), never from runtime.ts' },
  { match: /cannot be used as a constructor|Intl\.\w+ is not/,
    means: 'an Intl API Hermes lacks (RelativeTimeFormat, PluralRules, Locale)',
    rule: 'muten adds the FormatJS polyfill the screens need (muten/intl.js); the check runs without them (muten-hermes.js)' },
  { match: /Unable to resolve "(?!\.|virtual:)[^"]+" from/,
    means: 'the app asked for a package that was not installed yet (a change brought it, e.g. expo-sqlite for persist)',
    rule: 'every regeneration installs what the app\'s package.json asks for before it checks, then touches the screens so a running Metro bundles them again (installed() in native-project.ts)' },
  { match: /property 'bytecode' of undefined|Unpackers were compiled/,
    means: 'Reanimated\'s worklets Babel plugin was not applied: Metro started before the package was installed',
    rule: 'a session round that installs a new package restarts Metro with a clean cache (RESTART_METRO)' },
  { match: /__T is not defined/,
    means: 'a screen used the texts table before it was written',
    rule: 'the native tree is compiled where the web one is (compile.ts, genNode)' },
];

/** Starts a new record (the app is opening). */
export function resetErrors(dir: string): void {
  writeFileSync(join(dir, ERRORS_FILE), '');
  writeFileSync(join(dir, SESSION_FILE), '');
}

/** Text the session prints: on its terminal, and in the session log. */
export function say(dir: string, text: string, out: NodeJS.WriteStream = process.stdout): void {
  out.write(text);
  appendFileSync(join(dir, SESSION_FILE), text.replace(ANSI, ''));
}

/** `muten native --logs`: the open session's log, live, in any terminal (errors red, what went well green). */
export function followLogs(dir: string): Promise<boolean> {
  const file = join(dir, SESSION_FILE);
  if (!existsSync(file)) { console.error('✖ no session is open: muten native --android opens one'); return Promise.resolve(false); }
  const paint = (line: string): string => (/✖|ERROR|Error/.test(line) ? `${RED}${line}${RESET}` : /✓/.test(line) ? `${GREEN}${line}${RESET}` : /^\s*·/.test(line) ? `${DIM}${line}${RESET}` : line);
  let at = 0;
  const more = (): void => {
    const size = statSync(file).size;
    if (size < at) at = 0;   // a new session started: from its beginning
    if (size === at) return;
    const handle = openSync(file, 'r');
    const chunk = Buffer.alloc(size - at);
    readSync(handle, chunk, 0, chunk.length, at);
    closeSync(handle);
    at = size;
    for (const line of chunk.toString().split('\n')) if (line.trim()) console.log(paint(line));
  };
  console.log(`${DIM}· following ${file} (Ctrl+C to stop)${RESET}`);
  more();
  watch(file, more);
  return new Promise(() => {});   // until the person stops it
}

/** One error, from `side` (app, android, check), once per message. Says so on the terminal too. */
export function recordError(dir: string, side: string, message: string): void {
  const file = join(dir, ERRORS_FILE);
  const line = `[${side}] ${message}`;
  if (existsSync(file) && readFileSync(file, 'utf8').includes(line)) return;
  appendFileSync(file, `${new Date().toTimeString().slice(0, 8)} ${line}\n`);
  say(dir, `  ✖ ${line}\n`);
}

/** The errors on record, each with what muten knows of it; true when there are none. */
export function printErrors(dir: string): boolean {
  const file = join(dir, ERRORS_FILE);
  const lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n').filter(Boolean);
  if (!lines.length) { console.log('✓ no errors since the app opened'); return true; }
  const fresh = lines.filter((line) => !KNOWN.some((known) => known.match.test(line)));
  console.log(`✖ ${lines.length} error line(s) since the app opened${fresh.length ? `, ${fresh.length} NEW (no rule yet)` : ''}:\n`);
  for (const line of lines) {
    const known = KNOWN.find((one) => one.match.test(line));
    console.log(known ? `  ${line}\n      known: ${known.means}\n      muten now: ${known.rule}` : `  ★ NEW ${line}`);
  }
  if (fresh.length) console.log('\n  ★ NEW: understand it, turn it into a rule (compiler or check), then add it to KNOWN in src/native-errors.ts');
  return false;
}
