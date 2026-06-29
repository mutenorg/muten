// sourcemap.ts: a node-granularity source map (compiled JS -> the .muten line), built by SCANNING the final
// output for each node's `el_<id>` / `head_<id>` reference and mapping that line to the node's source loc.
//
// Post-hoc on purpose: the codegen captures when/each bodies into separate buffers, emitModule wraps the lines,
// and a blank-line tidy runs last — all of which shift line numbers, so threading a loc through the pipeline is
// fragile. Scanning the FINISHED text sidesteps all of it. esbuild then chains this: bundle map -> here -> .muten,
// so a runtime error shows `page.muten:18` in devtools instead of `boot-x.js:441`.

import type { Doc, Loc } from '#engine/shared/types.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// base64 VLQ: the source-map encoding. Sign goes in the low bit, then 5-bit groups with a continuation flag.
function vlq(value: number): string {
  let v = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do { let digit = v & 31; v >>>= 5; if (v > 0) digit |= 32; out += B64[digit]; } while (v > 0);
  return out;
}

// The first `_<id>` token on a line whose id is a real node -> that node's loc (covers el_/head_/outlet_/in_).
function lineLoc(line: string, doc: Doc): Loc | null {
  for (const m of line.matchAll(/_([A-Za-z0-9]+)\b/g)) {
    const loc = doc.nodes[m[1]]?.loc;
    if (loc) return loc;
  }
  return null;
}

// An inline `//# sourceMappingURL=…` comment for `js`, mapping each line to its node's .muten position.
export function inlineSourceMap(js: string, doc: Doc, file: string, source: string): string {
  const name = file.replace(/\\/g, '/').split('/').pop() || file;
  let prevLine = 0, prevCol = 0;
  const mappings = js.split('\n').map((line) => {
    const loc = lineLoc(line, doc);
    if (!loc) return ''; // unmapped line (imports, wrappers) — devtools falls back to the nearest mapped line
    const sl = loc.line - 1, sc = Math.max(0, (loc.col ?? 1) - 1);
    const seg = vlq(0) + vlq(0) + vlq(sl - prevLine) + vlq(sc - prevCol); // genCol 0, source 0, Δline, Δcol
    prevLine = sl; prevCol = sc;
    return seg;
  }).join(';');
  const map = { version: 3, file: name, sources: [name], sourcesContent: [source], names: [], mappings };
  return `\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
}
