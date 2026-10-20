// fields: the code of the standalone inputs (SearchField, Textarea, Password, Select, Checkbox, Date, Number, Range).
// Each is two-way bound to a state (or a row field inside an `each`), named by its own text for a screen reader, and
// takes `disabled when …`, `max(n)` and the rest through the shared generators (types.ts Emitter).
import { Nt, Ek } from '#engine/shared/vocab.js';
import type { NodeProps, Emitter, Expr, FlatNode, NodeEmitter } from '#engine/shared/types.js';

function searchField(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.value');
  em.push(`const el_${id} = document.createElement('input');`);
  em.push(`el_${id}.type = 'search';`);
  em.nameField(id, p.placeholder);   // a11y: the field's accessible name is its text (a placeholder alone is not one)
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('search', p))};`);
  em.interpAttr(id, 'placeholder', p.placeholder); // static OR interpolated ("Message #{channel}" stays reactive)
  if (p.max !== undefined) { // `max(n)` on a text input caps its LENGTH natively (maxlength): the browser refuses the n+1 char, no JS truncation to race
    const mj = em.logic.compileExpr(p.max, em.scope);
    em.push(p.max.kind === Ek.Lit ? `el_${id}.maxLength = ${mj};` : `effect(() => { el_${id}.maxLength = ${mj}; });`);
  }
  em.push(`effect(() => { if (el_${id}.value !== ${readJS}) el_${id}.value = ${readJS}; });`); // two-way: state->input so `.reset()` clears the box; guarded to avoid yanking the caret
  em.textWrite(id, p.bind, writeJS);
  em.genDynamics(id, p); // wire on(enter: send) / on(...) + conditional class on the input
  em.appendEl(id, parentVar);
}

// standalone multi-line input, two-way bound to a text state (same wiring as SearchField, a <textarea>)
function textarea(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.value');
  em.push(`const el_${id} = document.createElement('textarea');`);
  em.nameField(id, p.placeholder);   // a11y: the field's accessible name is its text (a placeholder alone is not one)
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('textarea', p))};`);
  em.interpAttr(id, 'placeholder', p.placeholder);
  if (p.max !== undefined) { // `max(n)` caps the textarea LENGTH natively (maxlength), same as SearchField
    const mj = em.logic.compileExpr(p.max, em.scope);
    em.push(p.max.kind === Ek.Lit ? `el_${id}.maxLength = ${mj};` : `effect(() => { el_${id}.maxLength = ${mj}; });`);
  }
  em.push(`effect(() => { if (el_${id}.value !== ${readJS}) el_${id}.value = ${readJS}; });`); // state -> input (so .reset() clears), caret-safe
  em.textWrite(id, p.bind, writeJS);
  em.genDynamics(id, p); // wire on(enter: send) / on(...) + conditional class
  em.appendEl(id, parentVar);
}

// standalone masked input, two-way bound to a text state (same wiring as SearchField, type=password)
function password(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.value');
  em.push(`const el_${id} = document.createElement('input');`);
  em.push(`el_${id}.type = 'password';`);
  em.nameField(id, p.placeholder);   // a11y: the field's accessible name is its text (a placeholder alone is not one)
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('password', p))};`);
  em.interpAttr(id, 'placeholder', p.placeholder);
  em.push(`effect(() => { if (el_${id}.value !== ${readJS}) el_${id}.value = ${readJS}; });`); // state -> input (so .reset() clears), caret-safe
  if (writeJS) em.push(`el_${id}.addEventListener('input', (e) => ${writeJS});`); else em.push(`el_${id}.readOnly = true;`);
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// standalone dropdown, two-way bound to a text state; options() is the fixed value list
function select(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.value');
  em.push(`const el_${id} = document.createElement('select');`);
  em.nameField(id, p.placeholder);   // a11y: the field's accessible name is its text (a placeholder alone is not one)
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('select', p))};`);
  if (typeof p.placeholder === 'string' && p.placeholder) em.push(`{ const o = document.createElement('option'); o.value = ''; o.textContent = ${JSON.stringify(p.placeholder)}; o.disabled = true; el_${id}.appendChild(o); }`); // non-selectable prompt while empty
  for (const opt of p.options || []) em.push(`{ const o = document.createElement('option'); o.value = ${JSON.stringify(opt)}; o.textContent = ${JSON.stringify(opt)}; el_${id}.appendChild(o); }`);
  em.push(`effect(() => { const __v = ${readJS}; if (el_${id}.value !== __v) el_${id}.value = __v; });`);
  if (writeJS) em.push(`el_${id}.addEventListener('change', (e) => ${writeJS});`); else em.push(`el_${id}.disabled = true;`);
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// bool checkbox wrapped in a <label> (clickable text + a11y). `disabled` targets the inner input.
function checkbox(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElement('label');`);
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('checkbox', p))};`);
  em.push(`const cb_${id} = document.createElement('input'); cb_${id}.type = 'checkbox';`);
  if (p.checked !== undefined) { // display a bool one-way; `-> action` toggles it (the store/query list-row pattern)
    em.push(`effect(() => { cb_${id}.checked = !!(${em.logic.compileExpr(p.checked, em.scope)}); });`);
    if (p.action) {
      const arg = p.arg !== undefined ? [p.arg, ...(p.argRest || [])].map((e) => em.logic.compileExpr(e, em.scope)).join(', ') : '';
      em.push(`cb_${id}.addEventListener('change', () => ${em.logic.actionRef(p.action)}(${arg}));`);
    } else em.push(`cb_${id}.disabled = true;`); // read-only display: no toggle handler
  } else { // bind: two-way to a page state
    const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.checked');
    em.push(`effect(() => { cb_${id}.checked = !!${readJS}; });`);
    if (writeJS) em.push(`cb_${id}.addEventListener('change', (e) => ${writeJS});`); else em.push(`cb_${id}.disabled = true;`);
  }
  em.push(`el_${id}.appendChild(cb_${id});`);
  if (p.label !== undefined) em.textEl(id + 'l', 'span', 'mu-checkbox-label', p.label, `el_${id}`);
  if (p.disabled !== undefined) { // the <label> can't be disabled — target the control
    const js = em.logic.compileExpr(p.disabled, em.scope);
    em.push(p.disabled.kind === Ek.Lit ? `cb_${id}.disabled = ${js};` : `effect(() => { cb_${id}.disabled = !!(${js}); });`);
  }
  em.genDynamics(id, { ...p, disabled: undefined }); // class/aria/on on the label; disabled handled above
  em.appendEl(id, parentVar);
}

// native date picker (<input type=date>), two-way bound to a date/text state (ISO string)
function date(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'e.target.value');
  em.push(`const el_${id} = document.createElement('input');`);
  em.push(`el_${id}.type = 'date';`);
  em.nameField(id, p.placeholder);   // a11y: the field's accessible name is its text (a placeholder alone is not one)
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('date', p))};`);
  em.push(`effect(() => { const __v = String(${readJS} ?? ''); if (el_${id}.value !== __v) el_${id}.value = __v; });`);
  if (writeJS) em.push(`el_${id}.addEventListener('input', (e) => ${writeJS});`); else em.push(`el_${id}.readOnly = true;`);
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// `Number bind(price) currency("COP")`: a money field. It shows the amount grouped the way the page's language writes it
// (9.000 · 9,000.50), takes decimals only when the currency has them (none for COP, two for USD), and keeps the plain number
// in the state. While the person types, only what is not part of a number goes; the grouping comes back when they leave it.
function money(em: Emitter, id: string, p: NodeProps, readJS: string, writeJS: string, parentVar: string): void {
  em.push(`const el_${id} = document.createElement('input');`, `el_${id}.type = 'text'; el_${id}.inputMode = 'decimal';`);
  em.nameField(id, p.placeholder);
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('number', p))};`);
  em.push(`{ const __fmt = new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'currency', currency: ${JSON.stringify(p.currency)} }); const __digits = __fmt.resolvedOptions().maximumFractionDigits; const __parts = new Intl.NumberFormat(document.documentElement.lang || undefined).formatToParts(1234.5); const __dec = (__parts.find((x) => x.type === 'decimal') || { value: '.' }).value;`
    + ` const __show = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '' : new Intl.NumberFormat(document.documentElement.lang || undefined, { minimumFractionDigits: 0, maximumFractionDigits: __digits }).format(Number(n)));`
    + ` const __read = (text) => { let t = ''; let seen = false; for (const ch of String(text)) { if (ch >= '0' && ch <= '9') t += ch; else if (ch === __dec) { if (__digits === 0 || seen) break; t += '.'; seen = true; } } if (seen) { const [a, b] = t.split('.'); t = a + '.' + b.slice(0, __digits); } return t === '' || t === '.' ? null : Number(t); };`
    + ` effect(() => { const __v = ${readJS}; if (document.activeElement !== el_${id}) el_${id}.value = __show(__v); });`
    + ` el_${id}.addEventListener('input', () => { const __n = __read(el_${id}.value); ${writeJS || ''}; });`
    + ` el_${id}.addEventListener('blur', () => { el_${id}.value = __show(__read(el_${id}.value)); }); }`);
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// numeric input two-way bound to a NUMBER state; Range = a slider. Value coerced with Number().
function number(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const isRange = em.nodes[id].type === Nt.Range;
  const readJS = em.logic.bindRead(p.bind, em.scope), writeJS = em.logic.bindWrite(p.bind, em.scope, 'Number(e.target.value)');
  if (p.currency && !isRange) { money(em, id, p, readJS, em.logic.bindWrite(p.bind, em.scope, '__n'), parentVar); return; }
  em.push(`const el_${id} = document.createElement('input');`);
  em.push(`el_${id}.type = ${JSON.stringify(isRange ? 'range' : 'number')};`);
  em.nameField(id, p.placeholder);
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor(isRange ? 'range' : 'number', p))};`);
  if (!isRange) em.interpAttr(id, 'placeholder', p.placeholder);
  const bounds: Array<[string, Expr | undefined]> = [['min', p.min], ['max', p.max], ['step', p.step]];
  for (const [attr, ex] of bounds) { // static literal OR reactive (a state-driven bound)
    if (ex === undefined) continue;
    const js = em.logic.compileExpr(ex, em.scope);
    em.push(ex.kind === Ek.Lit ? `el_${id}.setAttribute(${JSON.stringify(attr)}, ${js});` : `effect(() => { el_${id}.setAttribute(${JSON.stringify(attr)}, ${js}); });`);
  }
  // a slider says where it stands to its CSS: `--value` and `--fill` (how much of the track is behind the thumb), so the
  // app draws a filled track and a bubble that follows the thumb (`.range { background: linear-gradient(… var(--fill) …) }`)
  const fill = isRange ? ` el_${id}.style.setProperty('--value', __v); { const __lo = Number(el_${id}.min || 0), __hi = Number(el_${id}.max || 100); el_${id}.style.setProperty('--fill', ((Number(__v) - __lo) / ((__hi - __lo) || 1) * 100) + '%'); }` : '';
  em.push(`effect(() => { const __v = String(${readJS} ?? ''); if (el_${id}.value !== __v) el_${id}.value = __v;${fill} });`); // state -> input, caret-safe
  if (writeJS) em.push(`el_${id}.addEventListener('input', (e) => ${writeJS});`); else em.push(`el_${id}.readOnly = true;`);
  em.genDynamics(id, p); // class/aria/on + disabled
  em.appendEl(id, parentVar);
}

// a file picker that is also a drop zone: a <label> (styled by class(), it carries `data-over` while a file is dragged
// over it) around an input the browser draws nothing of. A `list<file>` state takes several; a drop takes what accept allows.
function file(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const head = String(p.bind ?? '').replace(/^@/, '');
  const many = (em.doc.state?.[head]?.type || '').startsWith('list');
  const writeJS = em.logic.bindWrite(p.bind, em.scope, many ? '__files' : '(__files[0] || null)');
  em.push(`const el_${id} = document.createElement('label');`);
  em.push(`el_${id}.className = ${JSON.stringify(em.classFor('file', p))};`);
  em.push(`{ const __in = document.createElement('input'); __in.type = 'file';${p.accept ? ` __in.accept = ${JSON.stringify(p.accept)};` : ''}${many ? ' __in.multiple = true;' : ''} __in.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none'; el_${id}.appendChild(__in);`
    + ` const __fits = (f) => { const a = __in.accept; return !a || a.split(',').some((k) => { k = k.trim().toLowerCase(); return k.endsWith('/*') ? (f.type || '').startsWith(k.slice(0, -1)) : k.startsWith('.') ? f.name.toLowerCase().endsWith(k) : f.type === k; }); };`
    + ` const __take = (__all) => { const __files = __all.filter(__fits); if (!__files.length) return; ${writeJS || ''}; };`
    + ` __in.addEventListener('change', () => { __take(__in.files ? [...__in.files] : []); __in.value = ''; });`
    + ` el_${id}.addEventListener('dragover', (e) => { e.preventDefault(); el_${id}.dataset.over = ''; }); el_${id}.addEventListener('dragleave', () => { delete el_${id}.dataset.over; });`
    + ` el_${id}.addEventListener('drop', (e) => { e.preventDefault(); delete el_${id}.dataset.over; __take(e.dataTransfer ? [...e.dataTransfer.files] : []); }); }`);
  if (p.label !== undefined) { em.push(`const el_${id}_t = document.createElement('span');`); em.interpAttr(`${id}_t`, 'textContent', p.label); em.push(`el_${id}.appendChild(el_${id}_t);`); }
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

/** How each node type here becomes DOM code. */
export const FIELDS_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.SearchField, searchField], [Nt.Textarea, textarea], [Nt.Password, password], [Nt.Select, select], [Nt.Checkbox, checkbox], [Nt.Date, date], [Nt.Number, number], [Nt.Range, number], [Nt.File, file]]);
