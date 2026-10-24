// icon-share: each icon's SVG written ONCE per page instead of at every `Icon` that shows it. Icons are resolved at
// build and were inlined at each use, inside the page's code or its static HTML: Storio's app shipped 2.4 MB of SVG,
// and 2 MB of it were the same icon repeated inside the same page (`Icon "lucide:check"` in every row of a list's
// template, every card, every tab: forty copies in one file).
// Now the page declares each icon it uses once, on its first line (`const __mi0 = "<svg …/svg>";`), and every place
// that wrote it refers to it. The swap happens on the page's finished code: every icon string the page resolved is,
// there, the inside of a double-quoted JS string (the compiler writes text with JSON.stringify), so `"…<svg …/svg>…"`
// becomes `"…" + __mi0 + "…"`, the same text at run time.
// (Sharing one copy ACROSS pages, as modules, was tried: it split the app into 120 tiny files a page had to fetch, for
// a tenth of the gain. Doing it right needs the app's whole icon set known before bundling.)
const LOCAL = '__mi';

/** A resolver that also remembers what it resolved for one page: what to share once the page is compiled. */
export function recordIcons(resolve: (ref: string) => string): { resolve: (ref: string) => string; used: Map<string, string> } {
  const used = new Map<string, string>();
  return { used, resolve: (ref: string): string => { const svg = resolve(ref); if (svg) used.set(ref, svg); return svg; } };
}

/** The page's code with each icon it used declared once and referenced where its SVG was written. */
export function shareIcons(code: string, used: ReadonlyMap<string, string>): string {
  const declared: string[] = [];
  let out = code;
  for (const svg of used.values()) {
    const written = JSON.stringify(svg).slice(1, -1);   // how the SVG reads inside the page's string literals
    if (!out.includes(written)) continue;
    const local = `${LOCAL}${declared.length}`;
    out = out.split(written).join(`" + ${local} + "`);
    declared.push(`const ${local} = ${JSON.stringify(svg)};`);
  }
  // on the first line, so every later line keeps its number (the page's source map points at the .muten by line)
  return declared.length ? declared.join(' ') + ' ' + out : code;
}
