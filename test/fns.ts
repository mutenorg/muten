// `get name(params) = expr`: a derived value that takes parameters, written in muten instead of a `use` .ts helper.
// It compiles to a plain hoisted function; calling it with the wrong number of values is an error, and its body is
// checked like any expression (with its params in scope).
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule, compileStore } from '#engine/compile/compile.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const codes = (src) => validate(toDoc(parse(src)), {}).diagnostics.map((d) => d.code);

const PAGE = `screen s
state { who = "ana" : text  n = 2 : number }
action more mutates n, who { n.set(n + 1)  who.set("eva") }
get label(name: text, count) = upper(name) + " ×" + count
Page { Text "{label(who, n)}"  Button "+" -> more }`;

{
  const ir = parse(PAGE);
  ok('parsed as a fn with two params', JSON.stringify(ir.fns?.label?.params) === '["name","count"]', JSON.stringify(ir.fns));
  ok('a clean page has no diagnostics', codes(PAGE).length === 0, codes(PAGE).join(','));
  const js = compileModule(toDoc(ir));
  ok('compiles to a hoisted function', /function label\(name, count\) \{ return /.test(js), js.match(/function label[^\n]*/)?.[0]);
  ok('the call site passes the reactive reads', js.includes('label(who.get(), n.get())'), js.match(/label\([^)]*\)/g)?.join(' | '));
  ok('params are not read as signals inside the body', !/name\.get\(\)|count\.get\(\)/.test(js), js.match(/function label[^\n]*/)?.[0]);
}

ok('wrong number of values → fn-arity', codes(PAGE.replace('label(who, n)', 'label(who)')).includes('fn-arity'), codes(PAGE.replace('label(who, n)', 'label(who)')).join(','));
ok('a typo inside the body is still caught', codes(PAGE.replace('upper(name)', 'upper(nmae)')).includes('unknown-ref'), codes(PAGE.replace('upper(name)', 'upper(nmae)')).join(','));
ok('an unknown function is still unknown', codes(PAGE.replace('label(who, n)', 'lable(who, n)')).includes('unknown-function'));

// in a store the fn is exported, like its gets
{
  const ir = parse('state { rate = 2 : number }\nget times(x) = x * rate');
  const js = compileStore({ state: ir.state || {}, gets: ir.gets || {}, fns: ir.fns || {}, domain: 'calc' });
  ok('store fn is exported', /export function times\(x\) \{ return /.test(js), js.match(/function times[^\n]*/)?.[0]);
  ok('store fn reads store state reactively', /function times\(x\) \{ return \(?x \* rate\.get\(\)/.test(js), js.match(/function times[^\n]*/)?.[0]);
}

// a page calls a store's fn as `domain.name(x)`: the shared helper lives in a .store, not in a .ts
{
  const ctx = { stores: { calc: { state: ['rate'], gets: [], actions: [], queries: [], fns: ['times'] } } };
  const vctx = { stores: ['calc'], storeMembers: { calc: ['rate'] }, storeFns: { calc: { times: ['x'] } } };
  const src = 'screen s\nstate { n = 3 : number }\naction more mutates n { n.set(n + 1) }\nPage { Text "{calc.times(n)}"  Button "+" -> more }';
  const diags = (code) => validate(toDoc(parse(code)), vctx).diagnostics.map((d) => d.code);
  ok('store fn call validates', diags(src).length === 0, diags(src).join(','));
  ok('store fn arity is checked', diags(src.replace('calc.times(n)', 'calc.times(n, n)')).includes('fn-arity'));
  ok('a store member that is no fn → no-methods', diags(src.replace('calc.times(n)', 'calc.tims(n)')).includes('no-methods'));
  ok('a method on a list → no-methods (teaches the vocabulary)', diags('screen s\nstate { xs = [ { a: 1 } ] : list }\nget r = xs.orderBy(a)\nPage { Text "hi" }').includes('no-methods'));
  const js = compileModule(toDoc(parse(src)), {}, '', {}, {}, ctx);
  ok('compiles to the store export, store imported', js.includes('__store_calc.times(n.get())') && /import \* as __store_calc/.test(js), js.match(/[^\n]*__store_calc[^\n]*/g)?.join(' | '));
}

// what a list-returning function gives back is read with its fields: a `use` that declares its type, a `get name(…)`,
// and any `get` over a list (a filter, a sort): the rows of an `each` over them are checked (they used to go unchecked)
{
  const base = (typed, body) => 'screen s\nentity Row { name text  done bool }\nuse rowsOf' + typed + ', fmt from "./lib.ts"\nstate { q = "" : text  tasks = [] : list<Row> }\nget rows = rowsOf(q)\nget open = tasks where not done\nget mine(x) = rowsOf(x)\nget mineRows = mine(q)\nPage { ' + body + ' }';
  const diags = (typed, body) => validate(toDoc(parse(base(typed, body))), {}).diagnostics.map((d) => d.code + (d.suggestion ? ':' + d.suggestion : ''));
  ok('use rowsOf: list<Row> → a typo in its rows is caught', diags(': list<Row>', 'each rows as r { Text "{r.nmae}" }').includes('unknown-member:name'));
  ok('…and a real field is clean', diags(': list<Row>', 'each rows as r { Text "{r.name}" }').length === 0);
  ok('each over a get filter checks its rows', diags('', 'each open as r { Text "{r.nmae}" }').includes('unknown-member:name'));
  ok('each over a get that calls a get name(…) checks its rows', diags(': list<Row>', 'each mineRows as r { Text "{r.nmae}" }').includes('unknown-member:name'));
  ok('an untyped use stays lenient', diags('', 'each rows as r { Text "{r.nmae}" }').length === 0);
  const ir = parse(base(': list<Row>', 'Text "x"'));
  ok('the declared type is kept', ir.imports?.[0]?.returns?.rowsOf === 'list<Row>' && JSON.stringify(ir.imports[0].names) === '["rowsOf","fmt"]', JSON.stringify(ir.imports));
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
