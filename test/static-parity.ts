// Static parity: a subtree with nothing reactive is sent as its renderStatic HTML (a zero-JS page, the pre-render, and
// since 0.1 every static subtree of a reactive page, cloned from a template). genNode builds the same thing call by
// call. Both must give the same markup, attribute for attribute, or a page changes depending on which path drew it
// (the static path had already lost the <nav> label and <main>'s id; the pre-render lost anchors and lazy images).
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile } from '#engine/compile/compile.js';
import { renderSsrBody } from '#engine/project/ssr.js';
import { Fmt } from '#engine/shared/vocab.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const SNIPPETS = {
  'Text': 'Text "hola" class("a")', 'Span': 'Span "x"', 'Title h2': 'Title "T" h2', 'Image': 'Image "/a.png" alt("A")',
  'Image eager': 'Image "/a.png" alt("A") eager', 'Link': 'Link "Ir" -> "/x"', 'Link with children': 'Link "" -> "/x" { Text "card" }',
  'Nav': 'Nav "Main" { Link "a" -> "/a" }', 'Stack': 'Stack class("s") { Text "a" }', 'Header': 'Header { Text "h" }',
  'Section': 'Section { Text "s" }', 'Footer': 'Footer { Text "f" }', 'List': 'List { Text "a"  Text "b" }',
  'List ordered': 'List ordered { Text "a" }', 'Video': 'Video "/v.mp4" autoplay muted loop', 'Button': 'Button "b"',
  'id()': 'Stack id("sec") { Text "x" }', 'Table': 'Table { Row head { Cell "h" }  Row { Cell "c" } }',
  'Details': 'Details "Más" { Text "x" }', 'Details open': 'Details "Más" open { Text "x" }', 'Details group': 'Details "Más" group("faq") { Text "x" }',
  'Icon': 'Icon "lucide:check"',
};
const iconResolver = (ref) => `<svg data-icon="${ref}"></svg>`;
// one attribute order for both sides, so only a real difference shows
const canon = (html) => html.replace(/<([a-z0-9]+)((?:\s+[^\s>=]+(?:="[^"]*")?)*)\s*>/g, (m, tag, attrs) => {
  const list = (attrs.match(/[^\s>=]+(?:="[^"]*")?/g) || []).sort();
  return `<${tag}${list.length ? ' ' + list.join(' ') : ''}>`;
});
for (const [name, snip] of Object.entries(SNIPPETS)) {
  const doc = toDoc(parse(`screen s\nPage { ${snip} }`));
  const zeroJs = compile(doc, {}, '', {}, {}, { iconResolver });
  const built = renderSsrBody(compile(doc, {}, '', {}, {}, { format: Fmt.Ssr, iconResolver }));
  const a = canon((zeroJs.match(/<main[\s\S]*<\/main>/) || [zeroJs])[0]), b = canon(built);
  ok(`${name}: renderStatic = genNode`, a === b, `\n     static:  ${a}\n     genNode: ${b}`);
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
