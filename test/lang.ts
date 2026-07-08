// New language powers: ternary + arithmetic (in expressions AND interpolation), `if` in actions,
// literal action args, Button label-interpolation + children, non-empty collection init.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile } from '#engine/compile/compile.js';
import { validate } from '#engine/ir/validate.js';
import { formatDiagnostic, diag } from '#engine/shared/diagnostics.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '  ← ' + e)); if (!c) f++; };

// ternary in a when condition
{
  const cond = parse('screen t\nMain { when a ? b : c { Text "x" } }').tree.children[0].props.cond;
  ok('ternary parsed', cond.kind === 'tern', cond.kind);
}
// arithmetic precedence: a + b * c → +(a, *(b, c))
{
  const cond = parse('screen t\nMain { when a + b * c { Text "x" } }').tree.children[0].props.cond;
  ok('add at top', cond.kind === 'bin' && cond.op === '+', cond.op);
  ok('mul under add', cond.right.op === '*', cond.right && cond.right.op);
}
// ternary + arithmetic INSIDE interpolation (display)
{
  const v = parse('screen t\nMain { Span "total {x * 12}" }').tree.children[0].props.value;
  const expr = v.parts.find((p) => p && p.kind);
  ok('interpolation parses an expression', expr.kind === 'bin' && expr.op === '*', JSON.stringify(expr));
}
// if/else in an action body
{
  const a = parse('screen t\nstate { o = "" : text }\naction t mutates o <- id { if o == id { o.reset() } else { o.set(id) } }\nMain { Text "x" }').actions.t;
  ok('if statement parsed', a.body[0].op === 'if', a.body[0] && a.body[0].op);
  ok('then branch', a.body[0].then[0].op === 'reset', a.body[0].then && a.body[0].then[0].op);
  ok('else branch', a.body[0].else[0].op === 'set', a.body[0].else && a.body[0].else[0].op);
}
// literal arg to an action
{
  const btn = parse('screen t\nMain { Button "B" -> pick("build") }').tree.children[0];
  ok('literal string arg', btn.props.arg.kind === 'lit' && btn.props.arg.value === 'build', JSON.stringify(btn.props.arg));
}
// multi-param action `action f(a: T, b: T)` — params parse, compile to a multi-arg signature + call
{
  const ir = parse('screen s\nstate { x = 0 : number }\naction f(a: number, b: number) mutates x { x.set(a) }\nPage { Button "y" -> f(1, 2) }');
  const a = ir.actions.f;
  ok('multi-param parsed', Array.isArray(a.params) && a.params.length === 2 && a.params[0].name === 'a' && a.params[0].type === 'number', JSON.stringify(a.params));
  ok('multi-param keeps input empty', a.input === '', JSON.stringify(a.input));
  const btn = ir.tree.children[0];
  ok('multi-arg call: 1st arg + rest', btn.props.arg.value === 1 && btn.props.argRest && btn.props.argRest[0].value === 2, JSON.stringify([btn.props.arg, btn.props.argRest]));
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('multi-param signature emitted', code.includes('function f(a, b)'), '');
  ok('multi-arg call emitted', code.includes('f(1, 2)'), '');
}
// backward-compat: the legacy `<- input` form still parses + compiles unchanged
{
  const ir = parse('screen s\nstate { x = 0 : number }\naction g mutates x <- v { x.set(v) }\nPage { Button "y" -> g(3) }');
  const a = ir.actions.g;
  ok('legacy input preserved', a.input === 'v' && a.params === undefined, JSON.stringify([a.input, a.params]));
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('legacy signature emitted', code.includes('function g(v)'), '');
  ok('legacy call emitted', code.includes('g(3)'), '');
}
// Button: interpolated label + children
{
  const b1 = parse('screen t\nMain { Button "{x}" -> a }').tree.children[0];
  ok('button label interpolates', b1.props.label.kind === 'interp', b1.props.label && b1.props.label.kind);
  const b2 = parse('screen t\nMain { Button -> a { Span "hi" } }').tree.children[0];
  ok('button accepts children', b2.children && b2.children[0].type === 'Span', b2.children && b2.children[0] && b2.children[0].type);
}
// non-empty list init in state
{
  const st = parse('screen t\nstate { tabs = [ { id: "a" } ] : list }\nMain { Text "x" }').state.tabs;
  ok('non-empty list init', Array.isArray(st.initial) && st.initial[0].id === 'a', JSON.stringify(st.initial));
}

// static page (no reactivity) → zero-runtime module (no signals, just innerHTML); class() passes straight through
{
  const ir = parse('screen about\nPage class("grid grid-cols-2 gap-4") { Title "Hi" h1  Text "Plain." Link "Home" -> "/" }');
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('static: NO runtime import', !code.includes("from 'virtual:muten/runtime'"), '');
  ok('static: uses innerHTML', code.includes('innerHTML'));
  ok('static: no signals/effects', !code.includes('signal(') && !code.includes('effect('));
  ok('static: class() passes through to the base', code.includes('grid-cols-2'), '');
}
// `Icon "set:name"` inlines the SVG resolved at build (Iconify) — a static name, no JS/runtime shipped.
{
  const ir = parse('screen s\nPage { Icon "lucide:settings" class("text-xl") }');
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module', iconResolver: (r) => '<svg>ICON-' + r + '</svg>' });
  ok('Icon: inlines the resolved SVG (build-time, no runtime)', code.includes('<svg>ICON-lucide:settings</svg>'), code.slice(0, 200));
  ok('Icon: span carries the mu-icon base + user class', code.includes('mu-icon') && code.includes('text-xl'));
}
// `Video "url" controls loop muted` — a <video> whose bare-keyword flags become boolean attrs.
{
  const ir = parse('screen s\nstate { x = "" : text }\nPage { Video "clip.mp4" controls loop muted  Text "{x}" }');
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('Video: a <video> element with src', code.includes("createElement('video')") && code.includes('clip.mp4'));
  ok('Video: bare-keyword flags -> boolean props', code.includes('.controls = true') && code.includes('.loop = true') && code.includes('.muted = true'));
}
// SearchField placeholder INTERPOLATES (reactive): `"Message #{channel}"` tracks the state, not a literal `{channel}`
{
  const code = compile(toDoc(parse('screen s\nstate { channel = "general" : text  q = "" : text }\nPage { SearchField bind @q "Message #{channel}" }')), {}, '', {}, {}, { format: 'module' });
  ok('SearchField placeholder is a reactive effect', /effect\(\(\) => \{[^}]*\.placeholder =/.test(code) && code.includes('channel'), code.slice(0, 120));
}
// `persist` backs a local state with localStorage: hydrate on load (fallback to the declared initial) + save on change
{
  const code = compile(toDoc(parse('screen s\nstate { mode = "dark" : text persist }\nPage { Text "{mode}" }')), {}, '', {}, {}, { format: 'module' });
  ok('persist: hydrates from localStorage with fallback', code.includes('signal(__loadLocal("muten:s:mode", "dark"))'), ''); // key namespaced by scope (screen "s")
  ok('persist: saves on every change via an effect', code.includes('effect(() => __saveLocal("muten:s:mode", mode.get()))'), '');
}
// `match subject { v -> … }` is SUGAR: desugars to one `when subject == "v"` per arm (validate/compile see Whens).
{
  const ir = parse('screen s\nstate { status = "" : text }\nPage { match status { active -> Text "ARM_A"  lead -> Text "ARM_L" } }');
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('match: both arms compile (one reactive When each)', code.includes('ARM_A') && code.includes('ARM_L'));
  ok('match: arms keyed on the subject value', code.includes('active') && code.includes('lead') && code.includes('status'));
}
// const: compile-time immutable SCALAR, inlined; rejects JS-style object literals
{
  const ir = parse('screen t\nconst TAX = 21\nstate { p = 0 : number }\nPage { Span "{p * TAX}" }');
  ok('const parsed', ir.consts.TAX === 21, JSON.stringify(ir.consts));
  ok('scalar const inlined', compile(toDoc(ir), {}, '', {}, {}, { format: 'module' }).includes('* 21'), '');
  let threw = false; try { parse('screen t\nconst X = { a: 1 }\nPage { Text "x" }'); } catch { threw = true; }
  ok('const rejects `= { }` (use a block)', threw);
}
// theme block: native Muten syntax (no = {} object literal)
{
  const ir = parse('theme {\n  space { md "16px" lg "24px" }\n  breakpoints { md "768px" }\n}');
  ok('theme block parsed', ir.theme.space.md === '16px' && ir.theme.breakpoints.md === '768px', JSON.stringify(ir.theme));
  ok('theme has no CSS string (base is in the stylesheet)', ir.theme.base === undefined, JSON.stringify(ir.theme));
}
// reactive page → normal module (imports the runtime)
{
  const code = compile(toDoc(parse('screen r\nstate { x = "" : text }\nPage { Text "{x}" }')), {}, '', {}, {}, { format: 'module' });
  ok('reactive: imports runtime', code.includes("from 'virtual:muten/runtime'"));
}
// comments: `#` (native) AND the JS-isms every model reaches for (`//`, `/* … */`) are tolerated — non-semantic
{
  let threw = ''; let ir = null;
  try { ir = parse('screen s // trailing\n# native\nstate { x = 0 : number /* inline */ }\n/* block\n comment */\nPage { Text "{x}" }'); }
  catch (e) { threw = String(e && e.message); }
  ok('comments: // /* */ # all tolerated', !threw && !!(ir && ir.state && ir.state.x), threw || 'no state');
}
// BOM: a leading UTF-8 BOM (Windows editors / model output) is skipped, not a hard error at 1:1
{
  let threw = '';
  try { parse('﻿screen s\nPage { Text "x" }'); } catch (e) { threw = String(e && e.message); }
  ok('BOM: leading \\uFEFF tolerated', !threw, threw);
}
// code frame: formatDiagnostic renders the offending source line + a caret at the exact column
{
  const out = formatDiagnostic(diag('syntax', 'x', { loc: { line: 2, col: 8 } }), 'f.muten', 'screen s\nPage { Text }');
  ok('code frame: shows the source line + a caret', out.includes('2 │ Page { Text }') && out.includes('^'), JSON.stringify(out));
}
// literal-initialized list infers its element shape — no `entity` needed — and still compiles to an iteration
{
  const doc = toDoc(parse('screen s\nstate { features = [ { title: "A", desc: "x" } ] : list  tags = [ "a", "b" ] : list }\nPage { each features as f { Text "{f.title}" }  each tags as t { Span "{t}" } }'));
  ok('inferred list: synth entity from the literal', !!(doc.entities && doc.entities.__features && 'title' in doc.entities.__features && 'desc' in doc.entities.__features), JSON.stringify(doc.entities));
  ok('inferred list: state retyped list<__features>', doc.state.features.type === 'list<__features>', doc.state.features.type);
  ok('inferred scalar list: retyped list<text>', doc.state.tags.type === 'list<text>', doc.state.tags.type);
  const code = compile(doc, {}, '', {}, {}, { format: 'module' });
  ok('inferred list: compiles (initial data + field read emitted)', code.includes('"A"') && code.includes('title'), code.slice(0, 160));
}
// a list<text>/scalar QUERY must survive the uuid auto-fill: `{ ...r }` on a string turned each row into
// `{0:'q',1:'w',…}` → the item rendered as "[object Object]". Scalar rows must pass through __fill untouched.
{
  const code = compile(toDoc(parse('screen s\nstate { ms = query models : list<text> }\nsources { models: { url: "http://x" } }\nPage { each ms.data as m { Span "{m}" } }')), {}, '', {}, {}, { format: 'module' });
  ok('scalar query rows pass through __fill (no [object Object])', code.includes("typeof r !== 'object'"), 'no scalar guard in emitted __fill');
}
// `each [ {…} {…} ] as x` — an inline static list: hoisted to a synth state, shape inferred, compiles + checks fields
{
  const doc = toDoc(parse('screen s\nPage { each [ { title: "A", desc: "x" }  { title: "B", desc: "y" } ] as c { Text "{c.title}" } }'));
  const synth = Object.keys(doc.state || {}).find((k) => k.startsWith('_inline'));
  ok('each [inline]: hoisted to a synthesized state', !!synth && doc.state[synth].type === 'list<__' + synth + '>', JSON.stringify(Object.keys(doc.state || {})));
  const code = compile(doc, {}, '', {}, {}, { format: 'module' });
  ok('each [inline]: compiles (inline rows + field read)', code.includes('"A"') && code.includes('title'), code.slice(0, 120));
  // the inferred shape is still CHECKED: `c.nope` isn't a field of the inline rows
  const diags = validate(toDoc(parse('screen s\nPage { each [ { title: "A" } ] as c { Text "{c.nope}" } }')), {}).diagnostics;
  ok('each [inline]: field access validated against the inferred shape', diags.some((d) => d.code === 'unknown-member'), JSON.stringify(diags.map((d) => d.code)));
}
// entity field can hold a list of scalars — `features list<text>` (feature bullets/tags), iterated with `each item.features`
{
  const ir = parse('entity Plan { name text required  features list<text> required }\nstate { items = [ { id: "1", name: "A", features: [ "x", "y" ] } ] : list<Plan> }\nPage { each items as p { each p.features as f { Text "{f}" } } }');
  ok('entity field can be list<scalar>', ir.entities.Plan.features === 'list<string>', ir.entities.Plan.features);
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module' });
  ok('list<scalar> field compiles (nested each over the field)', code.includes('features'), code.slice(0, 80));
}
// entity constraints accept the function-call style `min(8)`/`max(20)`/`pattern("…")` alongside `min:8`
{
  const c = parse('entity U { pw text required min(8) max(20)  zip text pattern("^\\\\d+$") }').constraints.U;
  ok('min(N)/max(N)/pattern(...) accepted like the colon form', c.pw.min === 8 && c.pw.max === 20 && typeof c.zip.pattern === 'string', JSON.stringify(c));
}
// `list.sortDesc by <field> take(n)` — sort then top-n in ONE expression (the "N most recent" / top-N need)
{
  const code = compile(toDoc(parse('screen s\nstate { xs = [ { d: "a", n: 1 } ] : list }\nget top = xs.sortDesc by d take(2)\nPage { each top as t { Text "{t.n}" } }')), {}, '', {}, {}, { format: 'module' });
  ok('sort by … take(n): compiles to sort().slice(0, n)', code.includes('.sort(') && /\.slice\(0,\s*2\)/.test(code), code.slice(0, 120));
}
// `Button -> "/route"` — teach Link (the string ↔ unknown-action loop that traps the model)
{
  let msg = '';
  try { parse('screen s\nPage { Button "Go" -> "/x" }'); } catch (e) { msg = String(e && e.message); }
  ok('Button -> "/route": teaches Link for navigation', msg.includes('Link') && msg.includes('ACTION'), msg);
}
// `list.orderBy(…)`/`.limit(…)` — a JS/LINQ method; teach muten's list vocabulary
{
  let msg = '';
  try { parse('screen s\nstate { xs = [ { a: 1 } ] : list }\nget r = xs.orderBy(a)\nPage { Text "hi" }'); } catch (e) { msg = String(e && e.message); }
  ok('.orderBy(): teaches muten list ops', msg.includes('no JS methods') && msg.includes('sort by'), msg);
}
// `: type` is OPTIONAL when a literal initial reveals it — `ok = false` infers bool (was cryptic `expected ":", got "}"`)
{
  const st = parse('screen s\nstate { ok = false  q = ""  n = 0  xs = [ { a: 1 } ] }\nPage { Text "hi" }').state;
  ok('scalar type inferred from initial', st.ok.type === 'bool' && st.q.type === 'text' && st.n.type === 'number' && st.xs.type === 'list', JSON.stringify([st.ok.type, st.q.type, st.n.type, st.xs.type]));
  let threw = ''; try { parse('screen s\nstate { z = null }\nPage { Text "x" }'); } catch (e) { threw = String(e && e.message); }
  ok('untyped `= null` (uninferrable) still teaches "needs a type"', threw.includes('needs a type'), threw);
}
// `\"` backslash-escaped quotes are TOLERATED (the universal JS instinct) → treated as a literal `"`, so the
// ternary-in-interpolation the model reaches for just works.
{
  let threw = ''; let ir = null;
  try { ir = parse('screen s\nstate { on = false }\nPage { Span "{on ? \\"a\\" : \\"b\\"}" }'); } catch (e) { threw = String(e && e.message); }
  ok('backslash-escaped `\\"` tolerated (→ literal quote, no error)', !threw && !!ir, threw);
}
// `each … where … take(n)` — filter then keep the first n (top-N of matching)
{
  const code = compile(toDoc(parse('screen s\nstate { xs = [ { n: "a", f: "F" }  { n: "b", f: "F" } ] : list }\nPage { each xs as x where x.f == "F" take(3) { Text "{x.n}" } }')), {}, '', {}, {}, { format: 'module' });
  ok('each where take(n): compiles to filter + slice', code.includes('.filter(') && /\.slice\(0,\s*3\)/.test(code), code.slice(0, 160));
}
// `Form bind(name, email)` / `bind({…})` — teach dropping Form for individual inputs
{
  let m1 = ''; try { parse('screen s\nstate { a = "" : text  b = "" : text }\nPage { Form bind(a, b) { SearchField bind(a) } }'); } catch (e) { m1 = String(e && e.message); }
  ok('bind(a, b): teaches DROP Form + individual inputs', m1.includes('ONE state') && m1.includes('DROP the `Form`'), m1);
}
// a bad char inside `{…}` (single quote) is located on the REAL line (not line 1) and teaches double quotes
{
  let loc = null, msg = '';
  try { parse("screen s\nstate { x = \"\" : text }\nPage { Span \"{x == 'a'}\" }"); } catch (e) { loc = e && e.loc; msg = String(e && e.message); }
  ok('single-quote in {…}: rebased to the real line + teaches double quotes', !!(loc && loc.line === 3) && msg.includes('double quotes'), JSON.stringify([loc, msg]));
}
// `if … then … else` in an expression → teach the ternary `cond ? a : b`
{
  let m = ''; try { parse('screen s\nstate { x = false }\nPage { Span "{if x then 1 else 2}" }'); } catch (e) { m = String(e && e.message); }
  ok('if/then/else in expr: teaches the ternary', m.includes('ternary') && m.includes('cond ? a : b'), m);
}
// `if` in the TREE → teach `when` (conditional rendering)
{
  let m = ''; try { parse('screen s\nstate { x = false }\nPage { if x { Text "a" } }'); } catch (e) { m = String(e && e.message); }
  ok('if in tree: teaches `when`', m.includes('when') && m.includes('conditional rendering'), m);
}
// `{x | money}` — a Vue/Angular pipe filter; teach the function call
{
  let msg = '';
  try { parse('screen s\nstate { n = 0 : number }\nPage { Span "{n | money}" }'); } catch (e) { msg = String(e && e.message); }
  ok('{x | money}: teaches money(x)', msg.includes('no pipe filters') && msg.includes('money(x)'), msg);
}
// `action f mutates { … }` (empty mutates list) teaches the fix, not a cryptic "expected ident"
{
  let msg = '';
  try { parse('screen s\naction donate mutates { }\nPage { Text "x" }'); } catch (e) { msg = String(e && e.message); }
  ok('mutates {} → names the state + the drop-it fix', msg.includes('at least one state name') && msg.includes('drop `mutates`'), msg);
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
