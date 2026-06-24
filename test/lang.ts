// New language powers: ternary + arithmetic (in expressions AND interpolation), `if` in actions,
// literal action args, Button label-interpolation + children, non-empty collection init.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile } from '#engine/compile/compile.js';
import { resolveToken, tokenClass, mergeTheme } from '#engine/style/tokens.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '  ← ' + e)); if (!c) f++; };

// a project theme (the engine ships NO values): tests that need scale/breakpoints pass this in
const TH = mergeTheme({ space: { sm: '8px', md: '16px', lg: '24px' }, font: { lg: '20px' }, breakpoints: { md: '768px', lg: '1024px' } });

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

// responsive: numeric scale + breakpoint prefix
{
  const s = parse('screen t\nPage { Stack style(cols.3, md:cols.4, gap.20) {} }').tree.children[0].props.style;
  ok('numeric + bp tokens parse', JSON.stringify(s) === JSON.stringify(['cols.3', 'md:cols.4', 'gap.20']), JSON.stringify(s));
  ok('bp resolves to base css', resolveToken('md:cols.4', TH) === resolveToken('cols.4', TH));
  ok('numeric scale resolves (no theme needed)', resolveToken('gap.20') === 'gap:20px', resolveToken('gap.20'));
  ok('bp class name', tokenClass('md:cols.4') === 't-md-cols-4', tokenClass('md:cols.4'));
}
// static page (no reactivity) → zero-runtime module (no signals, just innerHTML)
{
  const ir = parse('screen about\nPage style(gap.md, md:cols.2) { Title "Hi" h1  Text "Plain." Link "Home" -> / }');
  const code = compile(toDoc(ir), {}, '', {}, {}, { format: 'module', theme: TH });
  ok('static: NO runtime import', !code.includes("from 'virtual:muten/runtime'"), '');
  ok('static: uses innerHTML', code.includes('innerHTML'));
  ok('static: no signals/effects', !code.includes('signal(') && !code.includes('effect('));
  ok('static: emits @media for bp token', code.includes('@media (min-width:768px)'), '');
}
// theme is a PROJECT concern: a passed theme overrides the engine's default scale
{
  const th = mergeTheme({ space: { md: '20px' } });
  ok('project theme supplies the value', resolveToken('gap.md', th) === 'gap:20px', resolveToken('gap.md', th));
  ok('engine ships NO value (default scale empty)', resolveToken('gap.md') === null, resolveToken('gap.md'));
  const code = compile(toDoc(parse('screen t\nPage style(gap.md) { Text "x" }')), {}, '', {}, {}, { format: 'module', theme: th });
  ok('compile honors project theme', code.includes('gap:20px'), '');
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

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
