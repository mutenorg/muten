// GBNF acceptance: the generated grammar (grammar/muten.gbnf) must ACCEPT valid muten and REJECT the
// exact failure shapes that killed the repair loop in CONCLUSIONES §7.1. Guards against the generator
// or the vocabulary drifting away from the parser. Run after build (the grammar is regenerated there).
import GBNF, { RuleType } from 'gbnf';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const grammar = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'grammar', 'muten.gbnf'), 'utf8');
const accepts = (src) => {
  try { return [...GBNF(grammar, src)].some((r) => r.type === RuleType.END) ? 'ACCEPT' : 'partial'; }
  catch { return 'REJECT'; }
};

const VALID = {
  'counter (state+action+style+button)':
`screen home
state { count = 0 : number }
action inc mutates count { count.set(count + 1) }
Page style(padding.lg, gap.md) {
  Title "Count: {count}" h1
  Button "+1" -> inc
}`,
  'Link navigates with -> /route':
`screen home
Page { Link "Sign Up" -> /signup }`,
  'when + entity + form':
`screen signup
entity User { name text required  email email required }
state { draft = {} : User  done = false : bool }
action save mutates draft, done <- u { done.set(true) }
Page {
  Form bind @draft submit save "Save"
  when done { Text "Thanks!" }
}`,
};

const INVALID = {
  '// JS comment (muten uses #)':                  'screen home\n// hero\nPage { Text "x" }',
  'Tailwind in style() — max-w':                   'screen home\nPage style(max-w.2xl) { Text "x" }',
  'Button navigating to a /route (only Link can)': 'screen home\nPage { Button "Go" -> /signup }',
  'inline {} object type':                         'screen home\nstate { d = {} : { name text } }\nPage { Text "x" }',
};

let fail = 0;
const line = (ok, verdict, label) => { console.log(`${ok ? '✓' : 'x'} ${verdict.padEnd(7)} ${label}`); if (!ok) fail++; };
for (const [label, src] of Object.entries(VALID)) line(accepts(src) === 'ACCEPT', accepts(src), label);
for (const [label, src] of Object.entries(INVALID)) line(accepts(src) === 'REJECT', accepts(src), label);
console.log(fail ? `\n${fail} FAILURE(S)` : '\nALL OK');
process.exit(fail ? 1 : 0);
