// form: the code of a `Form`, an entity draft edited field by field. Every field is a group: a <label for> + the
// control + its error (linked by aria-describedby, announced live), with the entity's rules as the platform's own
// attributes (required / minlength / min / max, so :valid works) and muten's own checks on submit, worded in the
// page's language. Pure: it returns the lines; compile.ts declares and places the <form> element around them.
import { Fk } from '#engine/shared/vocab.js';
import type { EditableField, FieldConstraint, FormInput } from '#engine/shared/types.js';

// The built-in validation copy, in the language the PAGE declares (`meta { lang "es" }`): these are the engine's
// words, not the author's (nowhere in a .muten file to translate them). English for any language not here.
const FORM_COPY: { readonly [lang: string]: { readonly [key: string]: string } } = {
  es: { required: 'Obligatorio', email: 'Escribe un correo válido', pattern: 'Formato no válido',
        min: 'Mínimo {0}', max: 'Máximo {0}', minChars: 'Mínimo {0} caracteres', maxChars: 'Máximo {0} caracteres' },
  en: { required: 'Required', email: 'Enter a valid email', pattern: 'Invalid format',
        min: 'Min {0}', max: 'Max {0}', minChars: 'Min {0} characters', maxChars: 'Max {0} characters' },
};
const INPUT_TYPE: ReadonlyMap<string, string> = new Map([[Fk.Email, 'email'], [Fk.Number, 'number'], [Fk.Date, 'date'], [Fk.Password, 'password']]);
const TYPED: ReadonlySet<string> = new Set([Fk.Number, Fk.Text, Fk.Email, Fk.Password, Fk.Textarea]);   // fields a length or range applies to

type FieldVar = EditableField & { var: string; rule?: FieldConstraint };

// the control of one field, its id, its rules and its edit -> draft wiring
function fieldLines(input: FormInput, field: EditableField, fieldVar: string, group: string): string[] {
  const { slot, draft } = input;
  const out: string[] = [];
  const rule = input.constraints[field.name];
  if (field.kind === Fk.Enum) {
    out.push(`const ${fieldVar} = document.createElement('select');`, `${fieldVar}.className = ${JSON.stringify(slot('field-select', 'mu-field'))};`);
    for (const option of field.options) out.push(`{ const o = document.createElement('option'); o.value = ${JSON.stringify(option)}; o.textContent = ${JSON.stringify(rule?.choices?.[option] ?? option)}; ${fieldVar}.appendChild(o); }`);
  } else if (field.kind === Fk.Bool) {
    out.push(`const ${fieldVar} = document.createElement('input');`, `${fieldVar}.type = 'checkbox';`, `${fieldVar}.className = ${JSON.stringify(slot('field-check', 'mu-field-check'))};`);
  } else if (field.kind === Fk.Textarea) {
    out.push(`const ${fieldVar} = document.createElement('textarea');`, `${fieldVar}.className = ${JSON.stringify(slot('field-area', 'mu-field mu-field-area'))}; ${fieldVar}.rows = 4;`);
  } else {
    out.push(`const ${fieldVar} = document.createElement('input');`, `${fieldVar}.type = ${JSON.stringify(INPUT_TYPE.get(field.kind) ?? 'text')};`, `${fieldVar}.className = ${JSON.stringify(slot('field', 'mu-field'))};`);
  }
  out.push(`${fieldVar}.id = ${JSON.stringify(fieldVar)};`);   // matches the label's htmlFor
  // the rules as the platform's own attributes (`required` is announced, and makes :valid/:invalid work); `pattern`
  // stays muten's: HTML compiles it with other flags, and a diverging regex would mark a valid field invalid
  if (rule?.required) out.push(`${fieldVar}.required = true;`);
  const typed = TYPED.has(field.kind);
  if (typed && rule?.min !== undefined) out.push(field.kind === Fk.Number ? `${fieldVar}.min = ${JSON.stringify(String(rule.min))};` : `${fieldVar}.minLength = ${rule.min};`);
  if (typed && rule?.max !== undefined) out.push(field.kind === Fk.Number ? `${fieldVar}.max = ${JSON.stringify(String(rule.max))};` : `${fieldVar}.maxLength = ${rule.max};`);
  // each edit patches the draft immutably (so the reflect effect re-runs): a checkbox its boolean, a number coerced
  if (field.kind === Fk.Bool) out.push(`${fieldVar}.addEventListener('change', (e) => ${draft}.set({ ...${draft}.get(), ${JSON.stringify(field.name)}: e.target.checked }));`);
  else out.push(`${fieldVar}.addEventListener('input', (e) => ${draft}.set({ ...${draft}.get(), ${JSON.stringify(field.name)}: ${field.kind === Fk.Number ? '(Number(e.target.value) || 0)' : 'e.target.value'} }));`);
  out.push(`${group}.appendChild(${fieldVar});`);
  // an error line, linked and announced; an email field always has one (its format is always checked)
  if (rule || field.kind === Fk.Email) out.push(`const err_${fieldVar} = document.createElement('small'); err_${fieldVar}.className = ${JSON.stringify(slot('field-error', 'mu-field-error'))}; err_${fieldVar}.id = ${JSON.stringify('err_' + fieldVar)}; err_${fieldVar}.setAttribute('aria-live', 'polite'); ${fieldVar}.setAttribute('aria-describedby', ${JSON.stringify('err_' + fieldVar)}); ${group}.appendChild(err_${fieldVar});`);
  return out;
}

// the checks the submit runs, in the page's language; empty when no field carries a rule. A page that declares
// `meta { lang }` gets that language's words; one that does not says them in the language it is shown in at run time
// (<html lang>, which `lang.use` and the build set), so a Spanish app never answers «Required».
function submitChecks(fieldVars: FieldVar[], lang: string): string[] {
  const word = (table: { readonly [key: string]: string }, key: string, n?: number): string => (table[key] ?? FORM_COPY.en[key] ?? key).replace('{0}', String(n ?? ''));
  const msg = (key: string, n?: number): string => {
    if (lang) return JSON.stringify(word(FORM_COPY[lang.slice(0, 2).toLowerCase()] ?? FORM_COPY.en, key, n));
    const each = Object.fromEntries(Object.entries(FORM_COPY).map(([code, table]) => [code, word(table, key, n)]));
    return `(${JSON.stringify(each)}[(document.documentElement.lang || '').slice(0, 2).toLowerCase()] || ${JSON.stringify(word(FORM_COPY.en, key, n))})`;
  };
  const checks: string[] = [];
  for (const field of fieldVars) {
    if (!field.rule && field.kind !== Fk.Email) continue;
    const err = `err_${field.var}`, val = `String(__d[${JSON.stringify(field.name)}] ?? '')`, fail = (key: string, n?: number): string => `{ ${err}.textContent = ${msg(key, n)}; __ok = false; }`;
    const rule = field.rule;
    checks.push(`${err}.textContent = '';`);
    // a required checkbox must be CHECKED (String(false) is truthy: the old guard let it through)
    if (rule?.required) checks.push(field.kind === Fk.Bool ? `if (!__d[${JSON.stringify(field.name)}]) ${fail('required')}` : `if (!${val}.trim()) ${fail('required')}`);
    if (field.kind === Fk.Email) checks.push(`if (${val} && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(${val})) ${fail('email')}`);
    if (rule?.pattern) checks.push(`if (${val} && !new RegExp(${JSON.stringify(rule.pattern)}).test(${val})) ${fail('pattern')}`);
    // a number's min/max bound its value; a text's, its length
    if (rule?.min != null) checks.push(field.kind === Fk.Number ? `if (${val} !== '' && Number(${val}) < ${rule.min}) ${fail('min', rule.min)}` : `if (${val} && ${val}.length < ${rule.min}) ${fail('minChars', rule.min)}`);
    if (rule?.max != null) checks.push(field.kind === Fk.Number ? `if (${val} !== '' && Number(${val}) > ${rule.max}) ${fail('max', rule.max)}` : `if (${val}.length > ${rule.max}) ${fail('maxChars', rule.max)}`);
  }
  return checks;
}

/** The lines inside a Form: every field group, the submit button, the submit check and the draft -> fields reflection. */
export function formLines(input: FormInput): string[] {
  const { id, slot, draft } = input;
  // no title: the form used to open with «New <Entity>», the entity's NAME (a code identifier, in English) shown as
  // interface text; the one app that used a Form hid it with CSS. A heading is the page's to write.
  const out: string[] = [
    `el_${id}.noValidate = true;`,   // muten validates and words the errors; the browser's bubble would be a second, English-only voice
  ];
  const fieldVars: FieldVar[] = [];
  for (const field of input.fields) {
    const fieldVar = `f_${id}_${field.name}`, group = `g_${fieldVar}`;
    fieldVars.push({ ...field, var: fieldVar, rule: input.constraints[field.name] });
    out.push(`const ${group} = document.createElement('div'); ${group}.className = ${JSON.stringify(slot('field-group', 'mu-field-group'))};`);
    out.push(`{ const lb = document.createElement('label'); lb.className = ${JSON.stringify(slot('label', 'mu-label'))}; lb.htmlFor = ${JSON.stringify(fieldVar)}; lb.textContent = ${JSON.stringify(input.constraints[field.name]?.label ?? field.name.charAt(0).toUpperCase() + field.name.slice(1))}; ${group}.appendChild(lb); }`);
    out.push(...fieldLines(input, field, fieldVar, group), `el_${id}.appendChild(${group});`);
  }
  out.push(`{ const sb = document.createElement('button'); sb.type = 'submit'; sb.className = ${JSON.stringify(slot('submit', 'mu-submit'))}; el_${id}.appendChild(sb); effect(() => { sb.textContent = ${input.submitText}; }); }`);
  // the submit passes the draft to the action (a `<- item` action receives it); it runs only when every check passes
  const checks = submitChecks(fieldVars, input.lang);
  out.push(checks.length
    ? `el_${id}.addEventListener('submit', (e) => { e.preventDefault(); const __d = ${draft}.get(); let __ok = true; ${checks.join(' ')} if (__ok) ${input.submitAction}(__d); });`
    : `el_${id}.addEventListener('submit', (e) => { e.preventDefault(); ${input.submitAction}(${draft}.get()); });`);
  // the draft reflected back into the fields, so `draft.reset()` clears the form; unchanged values are left alone
  // (rewriting the field being typed in would move its caret)
  out.push('effect(() => {', `  const __d = ${draft}.get();`);
  for (const field of fieldVars) {
    if (field.kind === Fk.Bool) { out.push(`  { const v = !!__d[${JSON.stringify(field.name)}]; if (${field.var}.checked !== v) ${field.var}.checked = v; }`); continue; }
    const fallback = field.kind === Fk.Enum ? JSON.stringify(field.options[0]) : `''`;
    out.push(`  { const v = __d[${JSON.stringify(field.name)}] ?? ${fallback}; if (${field.var}.value !== v) ${field.var}.value = v; }`);
  }
  out.push('});');
  return out;
}
