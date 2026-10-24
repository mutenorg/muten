// dev-keys: `muten dev` answers single keys in a terminal (cli-help.ts DEV_KEYS): open the browser, run check, quit.
// Only when stdin is a terminal: under another script (Storio's dev.mjs starts the API and then the app) the keys are
// not theirs to take.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { lintApp } from './lint.js';
import { devKeysText } from './cli-help.js';

const OPENER: { [os: string]: string } = { darwin: 'open', win32: 'explorer' };
const CTRL_C = '\u0003';

/** Starts listening to the keys, once the server answers at `url`. */
export function devKeys(root: string, url: string): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  console.log('  press h for keys');
  process.stdin.on('data', (key: string) => {
    if (key === 'q' || key === CTRL_C) process.exit(0);
    if (key === 'h') console.log(devKeysText());
    if (key === 'o') spawn(OPENER[platform()] ?? 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    if (key === 'c') void lintApp(root, false);
  });
}
