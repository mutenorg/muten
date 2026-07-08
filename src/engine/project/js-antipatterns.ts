// js-antipatterns: the oracle reaching INTO a Custom's host `.js`. A `Custom` is a LEAF escape for the one thing the
// platform genuinely can't express (a map, a canvas, an iframe). When its `.js` instead hand-rolls UI muten already
// owns — a socket, an icon, a button — that's the #1 way an app (or an AI) accidentally rewrites muten in vanilla.
// The oracle can't see inside a Custom's behaviour, but it CAN read the file and warn, ON the offending `.js` line.
// These are WARNINGS (a Custom may legitimately touch the DOM), so they never fail `check` — they just nudge.
import { join, relative } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Diagnostic } from '#engine/shared/types.js';

interface Rule { re: RegExp; code: string; message: string; }
const RULES: readonly Rule[] = [
  { re: /\bnew\s+WebSocket\b/, code: 'js-hand-rolled-socket', message: 'Opening a WebSocket in a Custom — muten does real-time natively: `state { x = query feed live : list<T> }` + a `ws://` source. It reconnects and reconciles for you; never hand-roll the socket.' },
  { re: /\bnew\s+EventSource\b/, code: 'js-hand-rolled-socket', message: 'Streaming from an EventSource in a Custom — use a native `query x live` (WebSocket) instead; muten owns the connection.' },
  { re: /<svg[\s>]/i, code: 'js-inline-svg', message: 'Inline SVG in a Custom — use the native `Icon "set:name"` primitive (Iconify, inlined at build, tree-shaken) instead of hand-writing icon SVG.' },
  { re: /createElement\(\s*['"`](?:button|input|select|textarea|a)['"`]/, code: 'js-vanilla-ui', message: 'Building UI with document.createElement in a Custom — that element is a native muten primitive (`Button -> action`, `SearchField`, `Select`, `Link`). A Custom is a LEAF for what muten can\'t express, not a place to rebuild the UI.' },
];

// scan one file's text; comment lines are skipped so a doc-comment mentioning a pattern is not flagged.
function scan(text: string): Array<{ code: string; message: string; line: number; col: number }> {
  const out: Array<{ code: string; message: string; line: number; col: number }> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) out.push({ code: rule.code, message: rule.message, line: i + 1, col: (m.index ?? 0) + 1 });
    }
  }
  return out;
}

// Lint every host `.js`/`.ts` under src/components (the Custom escape files) and return warnings located IN that file.
export function lintComponents(appRoot: string): Array<{ file: string } & Diagnostic> {
  const dir = join(appRoot, 'src', 'components');
  if (!existsSync(dir)) return [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.ts')); } catch { return []; }
  const out: Array<{ file: string } & Diagnostic> = [];
  for (const f of files) {
    let text = ''; try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const file = relative(appRoot, join(dir, f));
    for (const w of scan(text)) out.push({ file, code: w.code, severity: 'warning', message: w.message, loc: { line: w.line, col: w.col }, suggestion: null });
  }
  return out;
}
