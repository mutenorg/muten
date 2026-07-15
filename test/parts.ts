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

// A part-arg string INTERPOLATES like every other string. Regression: `Tier(price: "{money(p.amount)}")` used to
// render the literal braces on the page while `muten check` stayed green (lint pass / runtime broken).
const tier = parse('part Tier(price: text) { Text $price }').parts.Tier;
const priced = compose(parse('screen t\neach plans as p { Tier(price: "{money(p.amount)}") }').tree, { Tier: tier }).tree.children?.[0];
const pv = priced?.props?.value;
check('part arg "{expr}" → Interp, not a literal string', Array.isArray(pv?.parts) && pv.parts[0]?.fn === 'money', JSON.stringify(pv));

// The nested case: the arg's parts must be SPLICED into the body's own interpolation. One outer slot holds a single
// `string | Expr`, so nesting it as a Lit would print the braces again.
const tier2 = parse('part Tier2(price: text) { Span "{$price}/mo" }').parts.Tier2;
const spliced = compose(parse('screen t\neach plans as p { Tier2(price: "{money(p.amount)}") }').tree, { Tier2: tier2 }).tree.children?.[0]?.props?.value;
check('nested "{$price}/mo": arg interp spliced into the body interp', spliced?.parts?.length === 2 && spliced.parts[0]?.fn === 'money' && spliced.parts[1] === '/mo', JSON.stringify(spliced));

// A brace-free arg must stay a plain, STATIC string (this is what keeps `Icon $icon` tree-shakeable — see above).
const plain = compose(parse('screen t\nPage { Tier(price: "$29") }').tree, { Tier: tier }).tree.children?.[0];
check('brace-free part arg stays a static string', plain?.props?.value === '$29', JSON.stringify(plain?.props));

// `class()` at the CALL SITE. It used to be a parse error: `class(` was read as a part instance NAMED `class`, and its
// string blew up parseArgs with "expected ident, got string". `class()` is muten's one styling mechanism and a part
// instance is a node — it takes one, and it APPENDS to the part root's classes, like a second `class()` on a primitive.
const box = parse('part Box() { Stack class("p-2") { slot } }').parts.Box;
const styled = compose(parse('screen t\nPage { Box() class("bg-white") { Span "hi" } }').tree, { Box: box }).tree.children?.[0];
check('class() on a part instance appends to the part root', JSON.stringify(styled?.props?.class) === '["p-2","bg-white"]', JSON.stringify(styled?.props?.class));

const bare = compose(parse('screen t\nPage { Box() { Span "hi" } }').tree, { Box: box }).tree.children?.[0];
check('no call-site class leaves the part root untouched', JSON.stringify(bare?.props?.class) === '["p-2"]', JSON.stringify(bare?.props?.class));

// The call site styles; it does not reach inside. `id`/`on`/`style` carry identity and behaviour that belong to the
// part's own definition, so they are refused BY NAME instead of bouncing off "expected ident, got string".
let modGuard = false;
try { parse('screen t\nPage { Box() id("hero") }'); } catch (e) { modGuard = /only `class\(…\)` can/.test(String(e)); }
check('a non-class modifier on a part instance is refused, and says why', modGuard);

// A part instance keeps its CALL SITE line — the only line the app owns for that subtree (a plugin part's own file
// lives in node_modules). Its inlined nodes carry `ownerPart`/`partLoc` instead, and never a page line number.
const inst = compose(parse('screen t\nPage {\n  Box() { Span "hi" }\n}').tree, { Box: box }).tree.children?.[0];
check('part instance root keeps the call-site loc', inst?.loc?.line === 3, JSON.stringify(inst?.loc));
check('inlined node carries its owner, and leaks no page line', inst?.ownerPart === 'Box' && !!inst?.partLoc, JSON.stringify({ owner: inst?.ownerPart, partLoc: inst?.partLoc }));

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL OK');
process.exit(fails ? 1 : 0);
