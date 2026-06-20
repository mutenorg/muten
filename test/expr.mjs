// Expression grammar (precedence) + when + text interpolation (parse-level).
import { parse } from '../engine/parse.js';

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

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
