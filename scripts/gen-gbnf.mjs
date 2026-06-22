#!/usr/bin/env node
// gen-gbnf — emit grammar/muten.gbnf (a GBNF grammar) from @muten/core's OWN vocabulary, so a local
// model can be constrained (llama.cpp / Ollama) to emit only syntactically-valid muten. The volatile
// lists — primitives, action ops, style families/atoms/breakpoints — are pulled from the manifest +
// tokens SOURCE OF TRUTH, so the grammar can't drift from the parser. Only the STRUCTURE is written by
// hand here (it changes rarely). Run AFTER `npm run build` (it reads dist/).
//
// What this kills at the decoding level (the CONCLUSIONES §7.1 failures): `//` comments (only `#`
// exists), Tailwind in style() (`max-w` has a `-`, not a token), inline `{}` object types, and
// `Button -> /route` (only Link takes a path arrow; Button takes an action ident).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIMITIVES, PRIMITIVE_NAMES, ACTION_OPS } from '../dist/engine/lang/manifest.js';
import { FAMILY_NAMES, ATOM_NAMES, BREAKPOINT_NAMES } from '../dist/engine/style/tokens.js';

const SELF = dirname(fileURLToPath(import.meta.url));
const alt = (xs) => xs.map((x) => `"${x}"`).join(' | ');

// Partition primitives by how `->` behaves — DERIVED from the manifest, so it stays correct:
//   Link  (props.to === 'route')  → `-> /path`     ·  Button/RowAction (props.action) → `-> action(arg)`
//   When/Each (control) + Custom  → handled by their own rules  ·  everything else → no arrow.
const LINK = PRIMITIVE_NAMES.filter((n) => PRIMITIVES[n].props && PRIMITIVES[n].props.to === 'route');
const ACTION = PRIMITIVE_NAMES.filter((n) => PRIMITIVES[n].props && PRIMITIVES[n].props.action);
const SPECIAL = new Set([...LINK, ...ACTION, 'Custom', 'When', 'Each']);
const PLAIN = PRIMITIVE_NAMES.filter((n) => !SPECIAL.has(n)); // Stack/Text/Title/…/slot (bare slot is fine)

const grammar = `# muten.gbnf — GENERATED from @muten/core by scripts/gen-gbnf.mjs. DO NOT EDIT BY HAND.
# A constrained-decoding grammar for ONE screen/page. Covers screen/state/store/const/get/entity/
# meta/use/param/action + the node tree + expressions. (app.muten: routes/shell/api/sources/theme/part
# are a separate file — out of scope for v1.)

root ::= ws "screen" sp ident ws decls node ws

decls ::= (decl ws)*
decl ::= use-decl | param-decl | const-decl | entity-decl | state-decl | store-decl | get-decl | meta-decl | action-decl

use-decl    ::= "use" sp ident (ws "," ws ident)* sp "from" sp string
param-decl  ::= "param" sp ident
const-decl  ::= "const" sp ident ws "=" ws scalar
entity-decl ::= "entity" sp ident ws "{" ws (field ws)* "}"
field       ::= ident sp ident (ws "|" ws ident)* (sp constraint)*
constraint  ::= "required" | ("min" | "max") ws ":" ws number
state-decl  ::= "state" ws "{" ws (statevar ws)* "}"
store-decl  ::= "store" ws "{" ws (statevar ws)* "}"
statevar    ::= ident ws "=" ws stateinit ws ":" ws type
stateinit   ::= "query" sp ident | value
type        ::= ident ("<" ident ">")?
get-decl    ::= "get" sp ident ws "=" ws expr
meta-decl   ::= "meta" ws "{" ws (ident sp string ws)* "}"
action-decl ::= "action" sp ident mutates? input? ws actionbody
mutates     ::= sp "mutates" sp ident (ws "," ws ident)*
input       ::= ws "<-" ws ident
actionbody  ::= "{" ws (stmt ws)* "}"
stmt        ::= ifstmt | requeststmt | callstmt
ifstmt      ::= "if" sp expr ws actionbody (ws "else" ws actionbody)?
requeststmt ::= ("post" | "put" | "delete") sp string (sp "body" sp expr)?
callstmt    ::= ident "." actionop "(" ws callargs ws ")"
actionop    ::= ${alt(ACTION_OPS)}
callargs    ::= refetcharg (ws "," ws refetcharg)* | predarg | expr | ""
refetcharg  ::= ident ws ":" ws expr
predarg     ::= ident ws "=>" ws expr

node       ::= whennode | eachnode | linknode | actionnode | customnode | plainnode
whennode   ::= "when" sp expr ws block
eachnode   ::= "each" sp expr sp "as" sp ident ws block
block      ::= "{" ws (node ws)* "}"
linknode   ::= ${alt(LINK)} (sp (commonpart | "->" ws path))* (ws block)?
actionnode ::= (${alt(ACTION)}) (sp (commonpart | actionarrow))* (ws block)?
actionarrow ::= "->" ws dotted (ws "(" ws expr? ws ")")?
customnode ::= "Custom" sp ident (sp modifier)*
plainnode  ::= (${alt(PLAIN)}) (sp commonpart)* (ws block)?
commonpart ::= string | ref | level | modifier
level      ::= "h" [1-6]

modifier   ::= stylemod | classmod | bindmod | submitmod | wheremod | columnsmod | altmod | inputsmod | onmod
stylemod   ::= "style" ws "(" ws styletoken (ws "," ws styletoken)* ws ")"
classmod   ::= "class" ws "(" ws classitem (ws "," ws classitem)* ws ")"
classitem  ::= (string | ident) (sp "when" sp expr)?
bindmod    ::= "bind" sp (ref | dotted)
submitmod  ::= "submit" sp dotted
wheremod   ::= "where" ws "(" ws clause (ws "," ws clause)* ws ")"
clause     ::= dotted ws cmpop ws (ref | value)
columnsmod ::= "columns" ws "(" ws ident (ws "," ws ident)* ws ")"
altmod     ::= "alt" sp string
inputsmod  ::= "inputs" ws "(" ws argpairs ws ")"
onmod      ::= "on" ws "(" ws argpairs ws ")"
argpairs   ::= argpair (ws "," ws argpair)*
argpair    ::= ident ws ":" ws argval
argval     ::= string | number | ref | dotted

styletoken ::= (breakpoint ":")? (atom | family "." tokenmod)
breakpoint ::= ${alt(BREAKPOINT_NAMES)}
atom       ::= ${alt(ATOM_NAMES)}
family     ::= ${alt(FAMILY_NAMES)}
tokenmod   ::= ("x." | "y.")? scaleseg
scaleseg   ::= ident | number

path    ::= ("/" pathseg?)+
pathseg ::= ident | "{" ws expr ws "}"

# expressions — the parser's precedence ladder (no left recursion: iterate, don't self-reference first)
expr      ::= ternary
ternary   ::= orexpr (ws "?" ws ternary ws ":" ws ternary)?
orexpr    ::= andexpr (sp "or" sp andexpr)*
andexpr   ::= cmpexpr (sp "and" sp cmpexpr)*
cmpexpr   ::= addexpr (ws cmpop ws addexpr)*
cmpop     ::= "==" | "!=" | "<=" | ">=" | "<" | ">" | "contains"
addexpr   ::= mulexpr (ws ("+" | "-") ws mulexpr)*
mulexpr   ::= unary (ws ("*" | "/") ws unary)*
unary     ::= ("not" sp)? primary
primary   ::= "(" ws ternary ws ")" | string | number | bool | "null" | callorref
callorref ::= dotted (ws "(" ws (ternary (ws "," ws ternary)*)? ws ")")?

value   ::= array | object | scalar
array   ::= "[" ws (value (ws "," ws value)*)? ws "]"
object  ::= "{" ws (objpair (ws "," ws objpair)*)? ws "}"
objpair ::= (ident | string) ws ":" ws value
scalar  ::= string | number | bool | "null" | ident

bool   ::= "true" | "false"
ref    ::= "@" ident ("." ident)*
dotted ::= "$"? ident ("." ident)*
ident  ::= [a-zA-Z_] [a-zA-Z0-9_]*
number ::= [0-9]+ ("." [0-9]+)?
string ::= "\\"" [^"]* "\\""

# whitespace — NO comments in the generation grammar on purpose: a weak model degenerates into
# comment spam (free whitespace) and never closes the page. Humans add comments by hand after.
ws     ::= wschar*
sp     ::= wschar+
wschar ::= [ \\t\\r\\n]
`;

// ── self-check: every referenced rule must be defined (catches typos / orphan rules) ──────────────
const defined = new Set();
for (const ln of grammar.split('\n')) { const m = ln.match(/^([a-z][a-z0-9-]*)\s*::=/); if (m) defined.add(m[1]); }
const body = grammar
  .replace(/\[(\\.|[^\]])*\]/g, ' ')   // strip char classes first (they contain " and #)
  .replace(/"(\\.|[^"])*"/g, ' ')      // then string literals
  .replace(/#[^\n]*/g, ' ');           // then comments
const refs = new Set(body.match(/[a-z][a-z0-9-]*/g) || []);
const missing = [...refs].filter((r) => !defined.has(r));
if (missing.length) { console.error('✗ GBNF references undefined rules:', missing.join(', ')); process.exit(1); }
const unused = [...defined].filter((r) => r !== 'root' && !body.replace(new RegExp(`^${r}\\s*::=`, 'm'), '').match(new RegExp(`\\b${r}\\b`)));
if (unused.length) console.warn('⚠ unused rules (defined, never referenced):', unused.join(', '));

mkdirSync(join(SELF, '..', 'grammar'), { recursive: true });
const out = join(SELF, '..', 'grammar', 'muten.gbnf');
writeFileSync(out, grammar);
console.log(`✓ wrote grammar/muten.gbnf — ${defined.size} rules, all references resolve`);
console.log(`  primitives: ${PLAIN.length} plain · ${LINK.length} link · ${ACTION.length} action · style: ${FAMILY_NAMES.length} families + ${ATOM_NAMES.length} atoms`);
