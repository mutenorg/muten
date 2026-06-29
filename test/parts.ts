// Parts: nesting (a part uses another) + param propagation through nesting.
import { parse } from '#engine/lang/parse.js';
import { compose } from '#engine/ir/compose.js';

let fails = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};

// two parts: Outer instantiates Inner
const lib = parse('part Inner(txt: text) { Text $txt }\npart Outer(t: text) { Stack { Inner(txt: $t) } }');
const parts = {};
for (const [n, d] of Object.entries(lib.parts)) parts[n] = d;

// page that uses Outer
const page = parse('screen t\nPage { Outer(t: "hi") }');
const { tree, used } = compose(page.tree, parts);

const stack = tree.children?.[0];
check('Outer → Stack', stack?.type === 'Stack', stack?.type);
const text = stack?.children?.[0];
check('nested Inner → Text', text?.type === 'Text', text?.type);
check('param propagated to nested ("hi")', text?.props?.value === 'hi', JSON.stringify(text?.props));
check('used records both parts', used.includes('Outer') && used.includes('Inner'), used.join(','));

// reference substitution: OBJECT param ($char.field) + ACTION param ($onSave) resolve to the arg
const lib2 = parse('part Card(char: C, onSave: action) { Stack { Image "{$char.image}"  Button "x" -> $onSave($char.id) } }');
const card = compose(parse('screen t\neach items as c { Card(char: c, onSave: addFav) }').tree, { Card: lib2.parts.Card }).tree;
const inner = card.children?.[0];               // each → Stack (the inlined Card)
const img = inner?.children?.[0];
const btn = inner?.children?.[1];
check('object param: $char.image → c.image', img?.props?.src?.parts?.[0]?.name === 'c.image', JSON.stringify(img?.props?.src));
check('action param: $onSave → addFav', btn?.props?.action === 'addFav', btn?.props?.action);
check('action arg: $char.id → c.id', btn?.props?.arg?.name === 'c.id', JSON.stringify(btn?.props?.arg));

// reactive class with a $param condition: `class(x when $flag)` must substitute the $param (regression: was a passthrough → toggle dropped)
const boxCls = compose(parse('screen t\nPage { Box(flag: on) }').tree, { Box: parse('part Box(flag: bool) { Stack class(active when $flag) { Text "x" } }').parts.Box }).tree.children?.[0];
check('class($param cond) substituted: $flag → on', boxCls?.props?.class?.[0]?.cond?.name === 'on', JSON.stringify(boxCls?.props?.class));

// a part can carry an Icon "set:name": the `name` prop substitutes the $param, so `Icon $icon` inlines to a
// STATIC literal (`Icon "lucide:users"`) → still tree-shaken at build. (Component principle for icon-laden UIs.)
const navIcon = compose(parse('screen t\nPage { NavItem(icon: "lucide:users") }').tree, { NavItem: parse('part NavItem(icon: text) { Icon $icon }').parts.NavItem }).tree.children?.[0];
check('part passes Icon: $icon → "lucide:users" (static after inline)', navIcon?.type === 'Icon' && navIcon?.props?.name === 'lucide:users', JSON.stringify(navIcon?.props));

// SLOT: a wrapper part with `slot` inlines the caller's children at that position (in the caller's scope).
const panel = parse('part Panel(title: text) { Stack class("card") { Span "{$title}"  slot } }').parts.Panel;
const filled = compose(parse('screen t\nPage { Panel(title: "Sales") { Text "a"  Text "b" } }').tree, { Panel: panel }).tree.children?.[0];
check('slot: wrapper Stack inlined', filled?.type === 'Stack', filled?.type);
check('slot: header stays before the slot', filled?.children?.[0]?.type === 'Span', filled?.children?.[0]?.type);
check('slot: caller children injected at the slot', filled?.children?.length === 3 && filled.children[1]?.props?.value === 'a' && filled.children[2]?.props?.value === 'b', JSON.stringify(filled?.children?.map((c) => c.type)));

// no children passed → the slot marker is removed (never survives to compile as a stray shell outlet).
const empty = compose(parse('screen t\nPage { Panel(title: "x") }').tree, { Panel: panel }).tree.children?.[0];
check('slot: no children → slot removed', empty?.children?.length === 1 && empty.children[0]?.type === 'Span', JSON.stringify(empty?.children?.map((c) => c.type)));

// nesting the SAME wrapper through a slot is finite (it's the caller's content), so the recursion guard must allow it.
let nestOk = true;
try {
  const nested = compose(parse('screen t\nPage { Panel(title: "out") { Panel(title: "in") { Text "deep" } } }').tree, { Panel: panel }).tree.children?.[0];
  const innerPanel = nested?.children?.[1];
  nestOk = innerPanel?.type === 'Stack' && innerPanel?.children?.[1]?.props?.value === 'deep';
} catch { nestOk = false; }
check('slot: nesting the same wrapper works (no false recursion)', nestOk);

// a part takes ONE slot — two is rejected at parse (would inject the same content twice).
let guard = false;
try { parse('part Bad() { Stack { slot  slot } }'); } catch { guard = true; }
check('slot: >1 slot in a part is rejected', guard);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL OK');
process.exit(fails ? 1 : 0);
