// Expression grammar (precedence) + when + text interpolation (parse-level).
import { parse } from '#engine/lang/parse.js';

let f = 0;
const c = (l, ok, e = '') => { console.log((ok ? '✓' : 'x') + ' ' + l + (ok ? '' : '   ← ' + e)); if (!ok) f++; };

// precedence: `a or b and c`  →  or(a, and(b, c))
{
  const when = parse('screen t\nPage { when a or b and c { Text "x" } }').tree.children[0];
  c('when → When node', when.type === 'When', when.type);
  const cond = when.props.cond;
  c('top op is or', cond.kind === 'bin' && cond.op === 'or', JSON.stringify(cond.op));
  c('right side is and', cond.right.op === 'and', cond.right?.op);
}

// comparison + unary not + parens: `not (x >= 3)`
{
  const cond = parse('screen t\nPage { when not (x >= 3) { Text "x" } }').tree.children[0].props.cond;
  c('not → unary', cond.kind === 'un' && cond.op === 'not', cond.kind);
  c('inner op is >=', cond.operand.op === '>=', cond.operand?.op);
}

// text interpolation: `"Hi, {user.name}!"`
{
  const v = parse('screen t\nPage { Text "Hi, {user.name}!" }').tree.children[0].props.value;
  c('Text value is interp', v.kind === 'interp', JSON.stringify(v));
  c('interp carries the ref', v.parts.some((p) => p.kind === 'ref' && p.name === 'user.name'), JSON.stringify(v.parts));
}

// inline object literal: `push({ title: name, qty: 1 })`
{
  const arg = parse('screen t\nstate { posts = [] : list<P> }\naction add mutates posts { posts.push({ title: name, qty: 1 }) }\nPage { Text "x" }').actions.add.body[0].arg;
  c('push arg is obj', arg.kind === 'obj', arg.kind);
  c('obj has 2 fields', arg.fields.length === 2, JSON.stringify(arg.fields?.length));
  c('field key + ref value', arg.fields[0].key === 'title' && arg.fields[0].value.kind === 'ref' && arg.fields[0].value.name === 'name', JSON.stringify(arg.fields[0]));
  c('field literal value', arg.fields[1].value.kind === 'lit' && arg.fields[1].value.value === 1, JSON.stringify(arg.fields[1]));
}

// in-place patch: `todos.patch where id == tid with { done: true }` (item-implicit, lambda-free)
{
  const st = parse('screen t\nstate { todos = [] : list<T> }\naction tog(tid: text) mutates todos { todos.patch where id == tid with { done: true } }\nPage { Text "x" }').actions.tog.body[0];
  c('stmt op is patch', st.op === 'patch', st.op);
  c('patch item-implicit (no param) + pred', st.param === undefined && st.pred.kind === 'bin', JSON.stringify([st.param, st.pred?.kind]));
  c('patch is obj literal', st.patch.kind === 'obj' && st.patch.fields[0].key === 'done', JSON.stringify(st.patch));
}

// list aggregate: `lines.count where done` (item-implicit predicate; grouped to compare)
{
  const cond = parse('screen t\nstate { lines = [] : list<L> }\nPage { when (lines.count where done) > 0 { Text "x" } }').tree.children[0].props.cond;
  const agg = cond.left;
  c('agg kind', agg.kind === 'agg', agg.kind);
  c('agg op/list, no param', agg.op === 'count' && agg.list === 'lines' && agg.param === undefined, JSON.stringify([agg.op, agg.list, agg.param]));
  c('agg body is bare field ref', agg.body.kind === 'ref' && agg.body.name === 'done', JSON.stringify(agg.body));
}

// list sort: `cs.sort by name` (item-implicit projection key, agg shape op=sort)
{
  const list = parse('screen t\nstate { cs = [] : list<C> }\nPage { each cs.sort by name as c { Text "x" } }').tree.children[0].props.list;
  c('sort is agg-shaped', list.kind === 'agg', list.kind);
  c('sort op/list, no param', list.op === 'sort' && list.list === 'cs' && list.param === undefined, JSON.stringify([list.op, list.list, list.param]));
}

// list-filter EXPRESSION: `ts where status == "todo"` — a standalone derived list (item fields bare)
{
  const e = parse('screen t\nstate { ts = [] : list<T> }\nget todo = ts where status == "todo"').gets.todo;
  c('filter kind', e.kind === 'filter', e.kind);
  c('filter list', e.list === 'ts', e.list);
  c('cond is the full comparison', e.cond.kind === 'bin' && e.cond.op === '==' && e.cond.left.kind === 'ref' && e.cond.left.name === 'status', JSON.stringify(e.cond));
}

// the cond is a FULL expression: `not done`, `and`/`or`, parens all parse after `where`
{
  const e = parse('screen t\nstate { ts = [] : list<T> }\nget x = ts where not done and (a or b)').gets.x;
  c('filter cond top op is and', e.kind === 'filter' && e.cond.kind === 'bin' && e.cond.op === 'and', JSON.stringify(e.cond?.op));
  c('filter cond left is not(done)', e.cond.left.kind === 'un' && e.cond.left.op === 'not', JSON.stringify(e.cond?.left));
}

// usable as an `each` list too: `each ts where status == "todo" as t`
{
  const list = parse('screen t\nstate { ts = [] : list<T> }\nPage { each ts where status == "todo" as t { Text "x" } }').tree.children[0].props.list;
  c('each-list filter kind', list.kind === 'filter' && list.list === 'ts', JSON.stringify([list.kind, list.list]));
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
