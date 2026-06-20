// Diagnostics: the compiler detects the error AND proposes the closest candidate.
import { parse } from '../engine/parse.js';
import { toDoc } from '../engine/flatten.js';
import { validate } from '../engine/validate.js';
import { ParseError } from '../engine/diagnostics.js';

let fails = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};
const diagsOf = (src) => validate(toDoc(parse(src))).diagnostics;

// 1. invalid style token → suggests the closest one + gives a position
{
  const d = diagsOf('screen t\nPage style(shadow.mdd) { Text "x" }').find((x) => x.code === 'unknown-token');
  check('invalid token detected', !!d, 'no diagnostic');
  check('suggests "shadow.md"', d?.suggestion === 'shadow.md', d?.suggestion);
  check('has loc (line/col)', !!(d?.loc?.line), JSON.stringify(d?.loc));
}

// 2. @ref to a missing state → suggests the close state
{
  const d = diagsOf('screen t\nstate { search = "" : text }\nPage { SearchField bind @serch "x" }').find((x) => x.code === 'unknown-ref');
  check('invalid @ref detected', !!d, 'no diagnostic');
  check('suggests "@search"', d?.suggestion === '@search', d?.suggestion);
}

// 3. unknown node type → suggests the close primitive
{
  const d = diagsOf('screen t\nPage { DataTabel @x }').find((x) => x.code === 'unknown-type');
  check('unknown type detected', !!d, 'no diagnostic');
  check('suggests "DataTable"', d?.suggestion === 'DataTable', d?.suggestion);
}

// 4. mutation not declared in `mutates` → suggests the declared target
{
  const src = 'screen t\nstate { users = "" : text }\naction a mutates users <- x {\n  userss.reset()\n}\nPage { Text "x" }';
  const d = diagsOf(src).find((x) => x.code === 'undeclared-mutation');
  check('undeclared mutation detected', !!d, 'no diagnostic');
  check('suggests "users"', d?.suggestion === 'users', d?.suggestion);
}

// 5. syntax error → ParseError with position
{
  let err = null;
  try { parse('screen t\nPage style(  {'); } catch (e) { err = e; }
  check('throws ParseError', err instanceof ParseError, String(err));
  check('ParseError has loc', !!(err?.loc?.line), JSON.stringify(err?.loc));
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL OK');
process.exit(fails ? 1 : 0);
