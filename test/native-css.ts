// The native output's CSS (engine/native/): the app's stylesheet turned into React Native styles at compile time. Each
// check is a rule of CSS that the phone does not follow by itself, or a failure that already showed on a phone: a
// percentage radius that crashed Android, a flex: 1 box that collapsed to nothing, a grid cell drawn in the wrong
// column, a class toggled on a chip whose label stayed dark, a layered base rule that outranked the app's own.
import { parse } from '#engine/lang/parse.js';
import { compose } from '#engine/ir/compose.js';
import { toDoc } from '#engine/ir/flatten.js';
import { length } from '#engine/native/units.js';
import { translate, PROFILE } from '#engine/native/profile.js';
import { parseSelector, picks } from '#engine/native/selectors.js';
import { mediaCondition } from '#engine/native/media.js';
import { gridPlan } from '#engine/native/grid.js';
import { readCss } from '#engine/native/css.js';
import { nativeLooks } from '#engine/native/styles.js';
import { PRIMITIVES } from '#engine/native/coverage.js';
import { Nt } from '#engine/shared/vocab.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${label}${cond ? '' : '   ← ' + extra}`); if (!cond) fails++; };
const show = (value) => JSON.stringify(value);

// a page and its stylesheet → each node's look, found by one of its classes
const looksOf = (source, css) => {
  const ir = parse(source);
  const doc = toDoc({ ...ir, tree: compose(ir.tree, {}).tree });
  const { looks, gaps } = nativeLooks(doc, readCss(css));
  const byClass = (name) => { const id = Object.keys(doc.nodes).find((key) => (doc.nodes[key].props?.class || []).some((entry) => (typeof entry === 'string' ? entry.split(/\s+/).includes(name) : entry.name === name))); return looks.get(id); };
  const all = (name) => Object.keys(doc.nodes).filter((key) => (doc.nodes[key].props?.class || []).some((entry) => typeof entry === 'string' && entry.split(/\s+/).includes(name))).map((key) => looks.get(key));
  return { byClass, all, gaps };
};
const one = (name, value) => { const out = {}; const gaps = []; translate(name, value, {}, out, gaps); return { out, gaps }; };

// ── units ──
ok('px are points, rem 16, % stays a percentage', length('10px') === 10 && length('1.5rem') === 24 && length('50%') === '50%');
ok('em waits for the node\'s font size; vh for the window', length('2em') === '__em:2' && length('46vh') === '__view:h:46' && length('100dvh') === '__view:h:100');
ok('calc() of absolute parts is computed', length('calc(16px + 2rem)') === 48 && length('calc((100px - 20px) / 2)') === 40 && length('calc(2 * 8px)') === 16);
ok('calc() mixing a percentage and points has no form', length('calc(100% - 20px)') === null);

// ── the profile ──
ok('gap with two values is row then column', show(one('gap', '10px 14px').out) === show({ rowGap: 10, columnGap: 14 }));
ok('inset sets the four sides', show(one('inset', '0').out) === show({ top: 0, right: 0, bottom: 0, left: 0 }));
{ const { out, gaps } = one('border-radius', '50%'); ok('a 50 % radius is as round as the box (Android crashed on "50%"), said as approximate', out.borderRadius === 9999 && gaps.some((gap) => gap.level === 'approx'), show({ out, gaps })); }
{ const { out, gaps } = one('font-size', '50%'); ok('a percentage font size is refused (points only on the phone)', out.fontSize === undefined && gaps.some((gap) => gap.level === 'none')); }
ok('an unknown property is a gap, never a silent loss', one('foo-bar', '1').gaps.some((gap) => gap.why.includes('profile')));
ok('flex: 1 is grow 1, shrink 1, basis 0 %', show(one('flex', '1').out) === show({ flexGrow: 1, flexShrink: 1, flexBasis: '0%' }));
ok('font-variant-numeric becomes fontVariant', show(one('font-variant-numeric', 'tabular-nums').out) === show({ fontVariant: ['tabular-nums'] }));
ok('a gradient background goes to the new architecture, said as approximate', one('background', 'linear-gradient(red, blue)').out.experimental_backgroundImage === 'linear-gradient(red, blue)');
{ const names = PROFILE.map(([name]) => name); ok('the profile has each property once', new Set(names).size === names.length); }
ok('every property the phone cannot say tells what to write instead', PROFILE.every(([, note]) => note.level !== 'none' || note.note.length > 10));

// ── selectors ──
{ const selector = parseSelector('.a > .b.c'); ok('a compound chain reads right to left', typeof selector !== 'string' && show(selector.parts.map((part) => part.classes)) === show([['b', 'c'], ['a']]) && selector.combinators[0] === '>'); }
ok('ids, attributes and siblings are reasons, not matches', typeof parseSelector('#x') === 'string' && typeof parseSelector('.a[x]') === 'string' && typeof parseSelector('.a + .b') === 'string');
{ const selector = parseSelector('.li:nth-child(2n+1)'); ok(':nth-child(2n+1) picks the odd places', typeof selector !== 'string' && picks(selector.parts[0].nths[0], 1) && !picks(selector.parts[0].nths[0], 2) && picks(selector.parts[0].nths[0], 3)); }
{ const selector = parseSelector('.fld input'); ok('an element name is matched against the tag the web gives the node', typeof selector !== 'string' && selector.parts[0].tag === 'input'); }

// ── media ──
ok('@media (min-width) reads the live screen', (mediaCondition('screen and (min-width: 768px)') || '').includes('>= 768'));
ok('print is never, a coarse pointer always', mediaCondition('print') === '(false)' && mediaCondition('(pointer: coarse)') === '(true)');
ok('a feature the phone cannot answer has no condition', mediaCondition('(min-resolution: 2dppx)') === null);

// ── grid ──
{ const plan = gridPlan('30px repeat(5, 1fr)', 6); ok('repeat() expands to its tracks', typeof plan !== 'string' && plan.tracks.length === 6 && plan.tracks[0].width === 30 && plan.tracks[5].fr === 1, show(plan)); }
ok('auto-fill needs the width first: a reason', typeof gridPlan('repeat(auto-fill, minmax(100px, 1fr))', 0) === 'string');

// ── the stylesheet ──
{ const sheet = readCss(':root { --ink: #111 }\n\n.a { color: var(--ink) }\n@layer base { .b { color: red } }\n@media (min-width: 700px) { .c { color: blue } }');
  ok('variables, lines, layers and media are kept', sheet.vars['--ink'] === '#111' && sheet.rules[0].line === 3 && sheet.rules[1].layer === 0 && sheet.rules[2].media === '(min-width: 700px)', show(sheet.rules)); }

// ── the cascade, on a real page ──
{ const { byClass } = looksOf('screen s\nPage { Stack class("card") { Text "x" class("t") } }', '.card .t { color: red }\n.t { color: blue }');
  ok('specificity: .card .t outranks .t written later', byClass('t').style.color === 'red'); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("card") { Text "x" class("t") } }', '@layer base { .card .t { color: red } }\n.t { color: blue }');
  ok('a rule outside every layer outranks a layered one, whatever its specificity', byClass('t').style.color === 'blue'); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("card") { Stack { Text "x" class("t") } } }', '.card { color: green; font-size: 20px }');
  ok('text style is inherited down through boxes', byClass('t').style.color === 'green' && byClass('t').style.fontSize === 20); }
{ const { byClass } = looksOf('screen s\nstate { on = false : bool }\nPage { Button "Hoy" -> go class("chip", sel when on) }\naction go mutates on { on.toggle() }', '.chip { color: #111 }\n.chip.sel { background: #000; color: #fff }');
  const chip = byClass('chip');
  ok('a toggled class paints the box and, on a Button, its label (the label stayed dark)', chip.conditional.some((entry) => entry.style.backgroundColor === '#000' && entry.text.color === '#fff'), show(chip.conditional)); }
{ const { byClass } = looksOf('screen s\nstate { on = false : bool }\nPage { Stack class("row", done when on) { Text "x" class("t") } }\naction go mutates on { on.toggle() }', '.row.done { color: gray; text-decoration: line-through }');
  ok('a toggled class on a box reaches the text inside it, under the same condition', byClass('t').conditional.some((entry) => entry.style.color === 'gray' && entry.cond), show(byClass('t').conditional)); }
{ const { all } = looksOf('screen s\nPage { Stack class("list") { Text "a" class("li")  Text "b" class("li")  Text "c" class("li") } }', '.li { border-bottom-width: 1px }\n.li:last-child { border-bottom-width: 0 }');
  const rows = all('li');
  ok(':last-child among fixed siblings is decided at compile time', rows[0].style.borderBottomWidth === 1 && rows[2].style.borderBottomWidth === 0, show(rows.map((row) => row.style))); }
{ const { byClass } = looksOf('screen s\nstate { xs = [ { n: "a" } ] : list }\nPage { Stack class("list") { each xs as x { Text "{x.n}" class("li") } } }', '.li:last-child { border-bottom-width: 0 }');
  ok(':last-child of a repeated row is checked on the phone by its index', byClass('li').conditional.some((entry) => (entry.js || '').includes('__rows_')), show(byClass('li').conditional)); }
{ const { byClass } = looksOf('screen s\nstate { q = "" : text }\nPage { Stack class("fld") { SearchField bind(q) "x" class("in") } }', '.fld input { font-size: 18px }');
  ok('.fld input reaches a field (an element selector)', byClass('in').text.fontSize === 18, show(byClass('in'))); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("side") { Text "x" } }', '.side { display: none }\n@media (min-width: 768px) { .side { display: flex } }');
  ok('@media becomes a style the live screen switches on', byClass('side').style.display === 'none' && byClass('side').conditional.some((entry) => (entry.js || '').includes('__screen')), show(byClass('side'))); }
{ const { byClass, all } = looksOf('screen s\nPage { Stack class("duo") { Stack class("cd")  Stack class("cd") } }', '.duo { display: grid; grid-template-columns: 1fr 1fr; gap: 10px }');
  ok('a grid has its tracks and gap, and its cells stretch to their row', byClass('duo').grid?.tracks.length === 2 && byClass('duo').grid?.columnGap === 10 && all('cd').every((cell) => cell.style.flexGrow === 1), show(byClass('duo'))); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("li") { Stack class("m") { Text "x" } } }', '.li { display: flex; flex-direction: column }\n.m { flex: 1 }');
  ok('flex: 1 in a column with no height keeps its content (it collapsed to nothing)', byClass('m').style.flexBasis === 'auto', show(byClass('m').style)); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("tc") { Stack class("fill") } }', '.fill { height: 100%; min-height: 52px }');
  ok('height: 100% of a box with no height fills what room there is (it grew into a bar)', byClass('fill').style.height === undefined && byClass('fill').style.flexGrow === 1, show(byClass('fill').style)); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("prog") { Stack class("bar") style(w: "50%") } }', '.bar { height: 5px; width: var(--w, 0%) }');
  ok('a variable the page sets with style() is read live, fallback or not (the bar stayed empty)', byClass('bar').live.some((entry) => entry.prop === 'width'), show(byClass('bar'))); }
{ const { byClass } = looksOf('screen s\nstate { n = 0 : number }\nPage { Button "Save" -> go class("cta") disabled when n == 0 }\naction go mutates n { n.set(1) }', '.cta { opacity: 1 }\n.cta:disabled { opacity: .32 }');
  ok(':disabled follows the button\'s own disabled condition', byClass('cta').conditional.some((entry) => entry.style.opacity === 0.32 && entry.cond)); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("row") { Span "7:00" class("t") } }', '.t { display: flex; align-items: center; justify-content: center }');
  ok('a text laid out as a flex box is drawn as a box with the text inside', byClass('t').boxed === true); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("b") { Text "x" } }', '.b { font-size: 20px; padding: 1em }');
  ok('em is the node\'s own font size', byClass('b').style.paddingTop === 20, show(byClass('b').style)); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("row") { Text "un texto largo" class("t") } }', '.row { display: flex }');
  ok('across a row an item shrinks as on the web (the text ran off the screen)', byClass('t').style.flexShrink === 1); }
{ const { byClass } = looksOf('screen s\nPage { Stack class("row") { Text "x" class("t") } }', '.row { white-space: nowrap }\n.t { text-overflow: ellipsis }');
  ok('white-space is inherited and becomes one line, cut with an ellipsis', byClass('t').textProps.numberOfLines === 1 && byClass('t').textProps.ellipsizeMode === 'tail', show(byClass('t').textProps)); }
{ const { gaps } = looksOf('screen s\nPage { Stack class("x") }', '.x:hover { color: red }');
  ok(':hover never happens on a touch screen: said, not dropped', gaps.some((gap) => gap.what === '.x:hover' && gap.level === 'approx')); }

// ── coverage: every primitive of the language has a decision for the phone ──
{ const missing = Object.values(Nt).filter((type) => !PRIMITIVES[type]);
  ok('every muten primitive has a line in the native coverage table', missing.length === 0, missing.join(', '));
  const drawn = Object.values(Nt).filter((type) => PRIMITIVES[type]?.level !== 'none').length;
  console.log(`  · ${drawn} of ${Object.values(Nt).length} primitives reach the phone`); }

console.log(fails ? `\n✗ ${fails} failed` : '\nALL OK');
process.exit(fails ? 1 : 0);
