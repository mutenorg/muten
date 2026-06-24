// Schema validation: a Form validates against the entity's constraints (required/min) on submit —
// blocks the action + shows per-field errors until every field is valid. Headless (fake DOM).
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compile } from '#engine/compile/compile.js';

const SRC = `
screen signup
entity Account { email email required  password text required min:6 }
state { draft = {} : Account  done = false : bool }
action submit mutates done <- d { done.set(true) }
Page {
  Form bind(draft) submit(submit) "Create"
  Text "{done}"
}
`;
const ir = parse(SRC);
const doc = toDoc(ir);
if (!validate(doc).ok) { console.error('validate failed'); process.exit(1); }
const code = compile(doc, ir.mock || {}).split('<script type="module">')[1].split('</script>')[0];

const reg = [];
function makeEl(tag) {
  const el = {
    tag, children: [], handlers: {}, className: '', value: '', textContent: '', type: '', placeholder: '',
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    replaceChildren(...n) { this.children = n; },
  };
  reg.push(el); return el;
}
const app = makeEl('div');
const document = { getElementById: () => app, createElement: (t) => makeEl(t) };
new Function('document', code)(document);

let f = 0;
const ok = (l, c) => { console.log((c ? '✓' : '✗') + ' ' + l); if (!c) f++; };
const form = reg.find((e) => e.handlers.submit);
const email = reg.find((e) => e.placeholder === 'email');
const pass = reg.find((e) => e.placeholder === 'password');
const errored = () => reg.some((e) => e.className === 'field-error' && e.textContent);
const done = () => reg.some((e) => e.tag === 'p' && e.textContent === 'true');

form.handlers.submit({ preventDefault() {} });
ok('empty submit is blocked', !done());
ok('shows a field error', errored());

email.handlers.input({ target: { value: 'a@b.io' } });
pass.handlers.input({ target: { value: '123' } });          // too short (min:6)
form.handlers.submit({ preventDefault() {} });
ok('short password still blocked', !done());

pass.handlers.input({ target: { value: '123456' } });        // now valid
form.handlers.submit({ preventDefault() {} });
await Promise.resolve();   // the result render batches into a microtask
ok('valid submit runs the action', done());

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
