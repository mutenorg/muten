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
    setAttribute(k, v) { this[k] = v; },   // a11y codegen sets aria-* via setAttribute
  };
  reg.push(el); return el;
}
const app = makeEl('div');
const document = { getElementById: () => app, createElement: (t) => makeEl(t), documentElement: { lang: 'es' } };   // <html lang>: the page speaks Spanish
new Function('document', code)(document);

let f = 0;
const ok = (l, c) => { console.log((c ? '✓' : '✗') + ' ' + l); if (!c) f++; };
const form = reg.find((e) => e.handlers.submit);
// a field is found the way its <label for> finds it: by id (the placeholder no longer repeats the field's name)
const email = reg.find((e) => typeof e.id === 'string' && e.id.endsWith('_email'));
const pass = reg.find((e) => typeof e.id === 'string' && e.id.endsWith('_password'));
const errored = () => reg.some((e) => e.className === 'mu-field-error' && e.textContent);
const done = () => reg.some((e) => e.tag === 'p' && e.textContent === 'true');

form.handlers.submit({ preventDefault() {} });
ok('empty submit is blocked', !done());
ok('shows a field error', errored());
ok('a page with no meta { lang } says it in its <html lang>: «Obligatorio»', reg.some((e) => e.className === 'mu-field-error' && e.textContent === 'Obligatorio'));

email.handlers.input({ target: { value: 'a@b.io' } });
pass.handlers.input({ target: { value: '123' } });          // too short (min:6)
form.handlers.submit({ preventDefault() {} });
ok('short password still blocked', !done());

pass.handlers.input({ target: { value: '123456' } });        // now valid
form.handlers.submit({ preventDefault() {} });
await Promise.resolve();   // the result render batches into a microtask
ok('valid submit runs the action', done());

// --- field types: password (masked), textarea (multi-line), date (native picker) ---
const doc2 = toDoc(parse(`screen profile
entity Prof { handle text required  secret password required min:8  about textarea  born date }
state { d = {} : Prof  saved = false : bool }
action save mutates saved <- p { saved.set(true) }
Page { Form bind(d) submit(save) "Save" }`));
ok('password/textarea/date form validates clean', validate(doc2).ok);
const code2 = compile(doc2, {}, '', {}, {}, { format: 'module' });
ok('password → input type="password"', /\.type = .password./.test(code2));
ok('textarea → <textarea> element', (code2.includes("createElement('textarea')") || code2.includes("__mk('textarea'")));
ok('date → input type="date"', /\.type = .date./.test(code2));
ok('password length still validates (min:8)', code2.includes('Min 8 characters'));

// --- an unknown field type is FLAGGED, not silently rendered as text ---
const bad = validate(toDoc(parse(`screen s
entity X { age numbr  link url }
state { d = {} : X }
action go mutates d <- v { d.reset() }
Page { Form bind(d) submit(go) "x" }`)));
const utf = bad.diagnostics.filter((x) => x.code === 'unknown-field-type');
ok('unknown field type "numbr" flagged with did-you-mean number', utf.some((x) => x.message.includes('"numbr"') && x.suggestion === 'number'));
ok('unknown field type "url" flagged', utf.some((x) => x.message.includes('"url"')));

// the constraints ride the platform's own attributes (so :valid / :invalid and screen readers see them), the form is
// novalidate (muten words the errors in the page's language), and pattern stays muten's
{
  const js = compile(toDoc(parse(SRC)));
  ok('required → the native required attribute', /f_\w+_email\.required = true;/.test(js) && /f_\w+_password\.required = true;/.test(js));
  ok('min:6 on a text → minLength', /f_\w+_password\.minLength = 6;/.test(js));
  ok('the form is novalidate', /\.noValidate = true;/.test(js));
}

// no interface text made from code: no «New <Entity>» title, no placeholder that is the field's identifier
ok('no title made from the entity name', !reg.some((e) => /^New /.test(e.textContent || '')));
ok('no placeholder repeating the field name', !reg.some((e) => e.placeholder === 'email' || e.placeholder === 'password'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
