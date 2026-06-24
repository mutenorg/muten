// ============================================================================
// Compile — the IR → runnable code stage
// ============================================================================
// The thesis of the engine, made concrete: NO virtual DOM. We emit imperative DOM construction
// plus fine-grained `effect`s that touch only what the changed state feeds — the abstraction
// disappears into code the browser runs directly.
//
// This file is the DOM half: it walks the flat node tree and emits element creation, bindings and
// the reactive effects (text interpolation, when/each, DataTable, Form). The behaviour half —
// expressions, action statements, state/action/effect declarations — lives in logic.ts; the output
// TEMPLATES (HTML / module / store wrappers) live in emit.ts. compile() orchestrates the three.
//
// where(): STATIC filters (role == admin) are pushed to the query (applied at the source); DYNAMIC
// ones (name contains @q) stay reactive on the client. A page with NO reactivity at all compiles to
// plain HTML with zero runtime (the Astro-like static path).

import { tokenClass, resolveToken, defaultTheme } from '#engine/style/tokens.js';
import { Nt, Ek, Fmt, Fk } from '#engine/shared/vocab.js';
import { customValue, CONTAINERS, parseClause, editableFields } from '#engine/compile/helpers.js';
import { emitStore, emitStatic, emitStaticHtml, emitSsr, emitModule, emitHtml } from '#engine/compile/emit.js';
import { Logic } from '#engine/compile/logic.js';
import type {
  Doc, NodeProps, Theme, Scope, Interp, StringPropValue, Value,
  CompileOpts, CompileCtx, EditableField, FieldConstraint, StoreInput, EmitParts,
} from '#engine/shared/types.js';

// Emit a .muten page as an ESM MODULE (for the Vite pipeline): exports mount(root) + css.
// opts.stores lets the page reference app-global store domains.
export function compileModule(doc: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  return compile(doc, data, projectCss, components, sources, { ...opts, format: Fmt.Module });
}

// Emit one .store DOMAIN slice (state + get + actions + effects) as a shared ESM module.
export function compileStore(input: StoreInput = {}, data: { [name: string]: Value } = {}, sources: { [name: string]: Value } = {}): string {
  const { state = {}, gets = {}, actions = {}, effects = [], entities = {}, imports = [] } = input;
  return compile({ screen: 'store', entities, state, actions, gets, effects, imports, consts: {}, constraints: {}, rootId: undefined, nodes: {} }, data, '', {}, sources, { format: Fmt.Store });
}

export function compile(doc: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  const { nodes, rootId, state, entities, screen } = doc;
  const theme: Theme = opts.theme || defaultTheme; // the scale comes from the project (else empty defaults)

  let lines: string[] = [];
  let hasSlot = false; // a shell with a `slot` returns its outlet from mount() so the router can target it

  // run a callback against a fresh buffer and return just the lines it emitted — used to capture the
  // body of a when/each into its own mount function before splicing it back at runtime.
  const capture = (emit: () => void): string[] => { const saved = lines; lines = []; emit(); const out = lines; lines = saved; return out; };

  // style(...) → atomic token classes; we record which tokens were used so only those reach the CSS.
  const usedTokens = new Set<string>();
  const classFor = (base: string, props: NodeProps): string => {
    for (const token of props.style || []) usedTokens.add(token);
    // style() = analyzable Muten tokens; class() = raw look (your CSS / Tailwind) passed straight through.
    // a conditional class (`name when cond`) is omitted here — genDynamics toggles it reactively.
    return [base, ...(props.style || []).map(tokenClass), ...(props.class || []).filter((c): c is string => typeof c === 'string')].join(' ');
  };

  // The shared compile context + the behaviour compiler that reads it (see logic.ts). `usedStores`
  // is the same Set both halves mutate, so a store touched in an expression here gets imported below.
  const stateKeys = new Set(Object.keys(state));
  const queryStates = new Set<string>(
    Object.entries(state).filter(([, def]) => typeof def.source === 'string' && def.source.startsWith('query:')).map(([name]) => name),
  );
  const usedStores = new Set<string>();
  const ctx: CompileCtx = {
    state, entities, actions: doc.actions, consts: doc.consts || {}, gets: doc.gets || {}, effects: doc.effects || [],
    stateKeys, queryStates, stores: opts.stores || {}, usedStores, params: new Set(doc.params || []), format: opts.format,
  };
  const logic = new Logic(ctx);
  const pageScope: Scope = { locals: new Set() }; // page-level expressions (interpolation, when/each)

  // reactive bits on an element: conditional classes (`class(active when cond)`) + events (`on(keydown: fn)`).
  const genDynamics = (id: string, p: NodeProps): void => {
    for (const c of p.class || []) if (typeof c !== 'string') lines.push(`effect(() => el_${id}.classList.toggle(${JSON.stringify(c.name)}, !!(${logic.compileExpr(c.cond, pageScope)})));`);
    for (const [event, act] of Object.entries(p.on || {})) if (typeof act === 'string') lines.push(`el_${id}.addEventListener(${JSON.stringify(event)}, () => ${logic.actionRef(act)}());`);
  };

  const genChildren = (id: string, parentVar: string): void => {
    for (const childId of nodes[id].children) genNode(childId, parentVar);
  };

  // an interpolation's parts joined into a JS string expression: "Hi, " + String(name ?? '') + …
  const interpConcat = (value: Interp): string =>
    value.parts.map((part) => typeof part === 'string' ? JSON.stringify(part) : `String(${logic.compileExpr(part, pageScope)} ?? '')`).join(' + ');

  // text-bearing primitives (Text/Span/Title): a plain string, or a (possibly reactive) interpolation.
  function genTextEl(id: string, tag: string, className: string, value: StringPropValue | undefined, parentVar: string): void {
    lines.push(`const el_${id} = document.createElement('${tag}');`);
    lines.push(`el_${id}.className = ${JSON.stringify(className)};`);
    if (typeof value === 'string') {
      lines.push(`el_${id}.textContent = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const concat = interpConcat(value);
      const reactive = value.parts.some((part) => typeof part !== 'string'); // an embedded {expr} ⇒ wrap in an effect
      lines.push(reactive ? `effect(() => { el_${id}.textContent = ${concat}; });` : `el_${id}.textContent = ${concat};`);
    }
    lines.push(`${parentVar}.appendChild(el_${id});`);
  }

  // set an attribute from a plain string or a (possibly reactive) interpolation (Image src/alt, labels).
  function genInterpAttr(id: string, attr: string, value: StringPropValue | undefined): void {
    if (typeof value === 'string') {
      lines.push(`el_${id}.${attr} = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const concat = interpConcat(value);
      const reactive = value.parts.some((part) => typeof part !== 'string');
      lines.push(reactive ? `effect(() => { el_${id}.${attr} = ${concat}; });` : `el_${id}.${attr} = ${concat};`);
    }
  }

  // Emit one node + its subtree into `parentVar`. Semantic containers share one generic path; every
  // other primitive has a case below. (Logic — refs, exprs, actions — is delegated to `logic`.)
  function genNode(id: string, parentVar: string): void {
    const n = nodes[id];
    const p = n.props || {};
    const cont = CONTAINERS[n.type]; // regions (Header/Nav/…) + Stack: [tag, baseClass]
    if (cont) {
      const [tag, base] = cont;
      lines.push(`const el_${id} = document.createElement('${tag}');`);
      lines.push(`el_${id}.className = ${JSON.stringify(classFor(base, p))};`);
      if (n.type === Nt.Nav && typeof p.label === 'string') lines.push(`el_${id}.setAttribute('aria-label', ${JSON.stringify(p.label)});`);
      lines.push(`${parentVar}.appendChild(el_${id});`);
      genDynamics(id, p);
      genChildren(id, `el_${id}`);
      return;
    }
    switch (n.type) {

      case Nt.SearchField: {
        const sig = logic.bindSig(p.bind);
        lines.push(`const el_${id} = document.createElement('input');`);
        lines.push(`el_${id}.type = 'search';`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('search', p))};`);
        if (typeof p.placeholder === 'string') lines.push(`el_${id}.placeholder = ${JSON.stringify(p.placeholder)};`);
        lines.push(`effect(() => { if (el_${id}.value !== ${sig}.get()) el_${id}.value = ${sig}.get(); });`); // two-way: state→input too (so `.reset()` clears the box), guarded to not yank the caret
        lines.push(`el_${id}.addEventListener('input', (e) => ${sig}.set(e.target.value));`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.DataTable: {
        const dataSig = logic.bindSig(p.data);
        const dataExpr = queryStates.has(dataSig) ? `${dataSig}.get().data` : `${dataSig}.get()`;
        const columns = p.columns || [];
        const clauses = (p.where || []).map(parseClause);
        const staticExpr = clauses.filter((c) => !c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join(''); // pushed to the source
        const dynExpr = clauses.filter((c) => c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join('');      // re-applied reactively
        const rowActions = n.children.map((cid) => nodes[cid]).filter((c) => c.type === Nt.RowAction);

        lines.push(`const el_${id} = document.createElement('table');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('datatable', p))};`);
        lines.push(`const head_${id} = el_${id}.createTHead().insertRow();`);
        for (const col of columns) {
          lines.push(`{ const th = document.createElement('th'); th.textContent = ${JSON.stringify(col)}; head_${id}.appendChild(th); }`);
        }
        if (rowActions.length) lines.push(`head_${id}.appendChild(document.createElement('th'));`);
        lines.push(`const body_${id} = el_${id}.createTBody();`);
        lines.push(`${parentVar}.appendChild(el_${id});`);

        // one row → a <tr>; `row` is the row SIGNAL, so each cell reacts to the row's data (granular — a changed
        // field rewrites only its <td>, never the row). RowAction args read the CURRENT row (`row.get()`).
        lines.push(`function renderRow_${id}(row) {`);
        lines.push(`  const tr = document.createElement('tr');`);
        for (const col of columns) {
          lines.push(`  { const td = document.createElement('td'); effect(() => { td.textContent = (row.get()[${JSON.stringify(col)}] ?? ''); }); tr.appendChild(td); }`);
        }
        for (const ra of rowActions) {
          const rp = ra.props || {};
          const rowScope = { locals: new Set<string>(), sigLocals: new Set(['row']) };
          const arg = rp.arg !== undefined ? [rp.arg, ...(rp.argRest || [])].map((e) => logic.compileExpr(e, rowScope)).join(', ') : '';
          lines.push(`  { const td = document.createElement('td'); const b = document.createElement('button'); b.className = ${JSON.stringify(classFor('row-action', rp))}; b.textContent = ${JSON.stringify(rp.label)}; b.addEventListener('click', () => ${logic.actionRef(rp.action)}(${arg})); td.appendChild(b); tr.appendChild(td); }`);
        }
        lines.push(`  return tr;`);
        lines.push(`}`);

        // KEYED reconciliation (same engine as `each`): rows matched by id, reused/moved/disposed — never a full rebuild.
        lines.push(`function base_${id}() { return ${dataExpr}${staticExpr}; }`);
        lines.push(`const start_${id} = document.createComment('rows');`);
        lines.push(`const anchor_${id} = document.createComment('/rows');`);
        lines.push(`body_${id}.appendChild(start_${id}); body_${id}.appendChild(anchor_${id});`);
        lines.push(`const map_${id} = new Map();`);
        lines.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });   // parent unmount → tear down every row`);
        lines.push(`effect(() => {`);
        lines.push(`  const __rows = base_${id}()${dynExpr};`);
        lines.push(`  const __seen = new Set();`);
        lines.push(`  let __prev = start_${id};`);
        lines.push(`  for (const __row of __rows) {`);
        lines.push(`    const __k = __row?.id ?? __row; __seen.add(__k);   // key by id (entities) or the value itself (scalars) — never index`);
        lines.push(`    let __e = map_${id}.get(__k);`);
        lines.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }`);
        lines.push(`    else { const __sig = signal(__row); const __r = root(() => [renderRow_${id}(__sig)]); __e = { sig: __sig, nodes: __r.value, dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }`);
        lines.push(`    for (const __n of __e.nodes) { if (__prev.nextSibling !== __n) anchor_${id}.parentNode.insertBefore(__n, __prev.nextSibling); __prev = __n; }`);
        lines.push(`  }`);
        lines.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }`);
        lines.push(`});`);
        break;
      }

      case Nt.Form: {
        const sig = logic.bindSig(p.bind);
        const entityName = state[sig]?.type; // validate rejects a non-local / non-entity bind; guard so a gap never throws a raw TypeError
        if (!entityName || !entities[entityName]) throw new Error(`Form must bind a page-local entity draft, not "${p.bind}"`);
        const fields = editableFields(entities[entityName]);
        const fc = (doc.constraints || {})[entityName] || {}; // per-field validation from the entity schema

        lines.push(`const el_${id} = document.createElement('form');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('form', p))};`);
        lines.push(`{ const t = document.createElement('div'); t.className = 'form-title'; t.textContent = ${JSON.stringify('New ' + entityName)}; el_${id}.appendChild(t); }`);

        const fieldVars: Array<EditableField & { var: string; c?: FieldConstraint }> = [];
        for (const f of fields) {
          const fv = `f_${id}_${f.name}`;
          fieldVars.push({ ...f, var: fv, c: fc[f.name] });
          if (f.kind === Fk.Enum) {
            lines.push(`const ${fv} = document.createElement('select');`);
            lines.push(`${fv}.className = 'field';`);
            for (const opt of f.options) {
              lines.push(`{ const o = document.createElement('option'); o.value = ${JSON.stringify(opt)}; o.textContent = ${JSON.stringify(opt)}; ${fv}.appendChild(o); }`);
            }
          } else if (f.kind === Fk.Bool) {
            lines.push(`const ${fv} = document.createElement('input');`);
            lines.push(`${fv}.type = 'checkbox';`);
            lines.push(`${fv}.className = 'field-check';`);
          } else {
            lines.push(`const ${fv} = document.createElement('input');`);
            lines.push(`${fv}.type = ${JSON.stringify(f.kind === Fk.Email ? 'email' : f.kind === Fk.Number ? 'number' : 'text')};`);
            lines.push(`${fv}.className = 'field';`);
            lines.push(`${fv}.placeholder = ${JSON.stringify(f.name)};`);
          }
          // each edit patches the bound draft's sub-field (immutably, so the reflect effect re-runs). A checkbox
          // stores its `checked` boolean; a number COERCES (`Number()`), else `e.target.value` is a raw string.
          if (f.kind === Fk.Bool) lines.push(`${fv}.addEventListener('change', (e) => ${sig}.set({ ...${sig}.get(), ${JSON.stringify(f.name)}: e.target.checked }));`);
          else {
            const val = f.kind === Fk.Number ? '(Number(e.target.value) || 0)' : 'e.target.value';
            lines.push(`${fv}.addEventListener('input', (e) => ${sig}.set({ ...${sig}.get(), ${JSON.stringify(f.name)}: ${val} }));`);
          }
          lines.push(`el_${id}.appendChild(${fv});`);
          if (fc[f.name]) lines.push(`const err_${fv} = document.createElement('small'); err_${fv}.className = 'field-error'; el_${id}.appendChild(err_${fv});`);
        }

        lines.push(`{ const sb = document.createElement('button'); sb.type = 'submit'; sb.className = 'submit'; sb.textContent = ${JSON.stringify(typeof p.submitLabel === 'string' ? p.submitLabel : 'Submit')}; el_${id}.appendChild(sb); }`);
        // submit: validate against the schema constraints; only run the action when every field passes.
        const vChecks: string[] = [];
        for (const fv of fieldVars) {
          if (!fv.c) continue;
          const err = `err_${fv.var}`, val = `String(__d[${JSON.stringify(fv.name)}] ?? '')`;
          vChecks.push(`${err}.textContent = '';`);
          if (fv.c.required) vChecks.push(`if (!${val}.trim()) { ${err}.textContent = 'Required'; __ok = false; }`);
          // a number field's min/max is a VALUE bound; a text field's is a character-length bound.
          if (fv.c.min != null) vChecks.push(fv.kind === Fk.Number
            ? `if (${val} !== '' && Number(${val}) < ${fv.c.min}) { ${err}.textContent = 'Min ${fv.c.min}'; __ok = false; }`
            : `if (${val} && ${val}.length < ${fv.c.min}) { ${err}.textContent = 'Min ${fv.c.min} characters'; __ok = false; }`);
          if (fv.c.max != null) vChecks.push(fv.kind === Fk.Number
            ? `if (${val} !== '' && Number(${val}) > ${fv.c.max}) { ${err}.textContent = 'Max ${fv.c.max}'; __ok = false; }`
            : `if (${val}.length > ${fv.c.max}) { ${err}.textContent = 'Max ${fv.c.max} characters'; __ok = false; }`);
        }
        // pass the bound draft to the submit action — a `<- item` action receives it (the whole point of a
        // Form); an action that reads the draft by name just ignores the extra arg. Mirrors `Button -> a(x)`.
        if (vChecks.length) {
          lines.push(`el_${id}.addEventListener('submit', (e) => { e.preventDefault(); const __d = ${sig}.get(); let __ok = true; ${vChecks.join(' ')} if (__ok) ${logic.actionRef(p.submit)}(__d); });`);
        } else {
          lines.push(`el_${id}.addEventListener('submit', (e) => { e.preventDefault(); ${logic.actionRef(p.submit)}(${sig}.get()); });`);
        }

        // reflect the bound draft back into the fields, so `draft.reset()` clears the form for free.
        // The value-changed guard avoids yanking the caret of the field currently being typed.
        lines.push(`effect(() => {`);
        lines.push(`  const d = ${sig}.get();`);
        for (const fv of fieldVars) {
          if (fv.kind === Fk.Bool) { lines.push(`  { const v = !!d[${JSON.stringify(fv.name)}]; if (${fv.var}.checked !== v) ${fv.var}.checked = v; }`); continue; }
          const def = fv.kind === Fk.Enum ? JSON.stringify(fv.options[0]) : `''`;
          lines.push(`  { const v = d[${JSON.stringify(fv.name)}] ?? ${def}; if (${fv.var}.value !== v) ${fv.var}.value = v; }`);
        }
        lines.push(`});`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Text: genTextEl(id, 'p', classFor('text', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Span: genTextEl(id, 'span', classFor('span', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Title: genTextEl(id, p.level || 'h1', classFor('title', p), p.value, parentVar); genDynamics(id, p); break; // level via keyword; <h1> default

      case Nt.Image: {
        lines.push(`const el_${id} = document.createElement('img');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('image', p))};`);
        genInterpAttr(id, 'src', p.src);
        genInterpAttr(id, 'alt', p.alt ?? ''); // alt is required by the manifest; "" = decorative
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.When: {
        // conditional render: an effect mounts the children once when the condition becomes true and
        // removes them when it becomes false, using a comment node as a stable insertion anchor.
        if (!p.cond) throw new Error('when without a condition');
        const condJS = logic.compileExpr(p.cond, pageScope);
        const body = capture(() => genChildren(id, '__p'));
        lines.push(`function build_${id}(__p) {`);
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const anchor_${id} = document.createComment('when');`);
        lines.push(`${parentVar}.appendChild(anchor_${id});`);
        lines.push(`let shown_${id} = null;   // { value: nodes, dispose } while mounted, else null — dispose kills the block's effects on unmount (no zombies)`);
        lines.push(`onCleanup(() => { if (shown_${id}) shown_${id}.dispose(); });   // parent unmount → tear down the mounted block too`);
        lines.push(`effect(() => {`);
        lines.push(`  if (${condJS}) {`);
        lines.push(`    if (!shown_${id}) { const __r = root(() => { const __f = document.createDocumentFragment(); build_${id}(__f); return [...__f.childNodes]; }); for (const __n of __r.value) anchor_${id}.parentNode.insertBefore(__n, anchor_${id}); shown_${id} = __r; }`);
        lines.push(`  } else if (shown_${id}) { shown_${id}.dispose(); for (const __n of shown_${id}.value) __n.remove(); shown_${id} = null; }`);
        lines.push(`});`);
        break;
      }

      case Nt.Each: {
        // KEYED reconciliation (fine-grained, no VDOM): each row is backed by a per-row signal. The body's
        // bindings read it, so when a row's data changes ONLY that binding updates — never a full rebuild.
        // Rows are matched by `id` (never index — that bleeds state), reused/moved in place, and disposed
        // (effects too) when they leave. So focus / scroll / inputs survive live updates.
        if (!p.list || !p.as) throw new Error('each without a list or item variable');
        const listJS = logic.compileExpr(p.list, pageScope);
        const filterJS = p.filter ? logic.compileExpr(p.filter, pageScope) : ''; // `where cond` — item var bare (the raw row inside .filter)
        // the body reads the row through its signal → compile its refs as `<as>.get()` (restore the scope after)
        const prevSig = pageScope.sigLocals;
        pageScope.sigLocals = new Set([...(prevSig || []), p.as]);
        const body = capture(() => genChildren(id, '__p'));
        pageScope.sigLocals = prevSig;
        lines.push(`function buildItem_${id}(__p, ${p.as}) {`); // ${p.as} is the row SIGNAL; body refs compiled as ${p.as}.get()
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const start_${id} = document.createComment('each');`);
        lines.push(`const anchor_${id} = document.createComment('/each');`);
        lines.push(`${parentVar}.appendChild(start_${id}); ${parentVar}.appendChild(anchor_${id});`);
        lines.push(`const map_${id} = new Map();   // row id → { sig, nodes, dispose, data }`);
        lines.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });   // parent unmount → tear down every row (no leaked effects)`);
        lines.push(`effect(() => {`);
        lines.push(`  const __rows = (${listJS} ?? [])${filterJS ? `.filter((${p.as}) => ${filterJS})` : ''};`);
        lines.push(`  const __seen = new Set();`);
        lines.push(`  let __prev = start_${id};`);
        lines.push(`  for (const __row of __rows) {`);
        lines.push(`    const __k = __row?.id ?? __row; __seen.add(__k);   // key by id (entities) or the value itself (scalars) — never index`);
        lines.push(`    let __e = map_${id}.get(__k);`);
        lines.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }   // same row, changed data → granular update`);
        lines.push(`    else { const __sig = signal(__row); const __r = root(() => { const __f = document.createDocumentFragment(); buildItem_${id}(__f, __sig); return [...__f.childNodes]; }); __e = { sig: __sig, nodes: __r.value, dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }   // new row`);
        lines.push(`    for (const __n of __e.nodes) { if (__prev.nextSibling !== __n) anchor_${id}.parentNode.insertBefore(__n, __prev.nextSibling); __prev = __n; }   // order: move only if out of place`);
        lines.push(`  }`);
        lines.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }   // gone → dispose effects + remove nodes`);
        lines.push(`});`);
        break;
      }

      case Nt.Custom: {
        // escape hatch: mount a host-written component (opaque to the IR), wired via inputs/on.
        lines.push(`const el_${id} = document.createElement('div');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('custom', p))};`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        const ins = Object.entries(p.inputs || {}).map(([k, v]) => `${JSON.stringify(k)}: ${customValue(v)}`).join(', ');
        const ons = Object.entries(p.on || {}).map(([ev, act]) => `${JSON.stringify(ev)}: (...__a) => ${logic.actionRef(typeof act === 'string' ? act : '')}(...__a)`).join(', ');
        lines.push(`if (typeof __custom_${p.component} === 'function') __custom_${p.component}(el_${id}, { ${ins} }, { ${ons} });`);
        break;
      }

      case Nt.Button: {
        lines.push(`const el_${id} = document.createElement('button');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('button', p))};`);
        if (n.children && n.children.length) genChildren(id, `el_${id}`);          // children ⇒ a clickable card
        else if (p.label !== undefined) genInterpAttr(id, 'textContent', p.label); // else a static OR interpolated label
        if (p.action) {
          const arg = p.arg !== undefined ? [p.arg, ...(p.argRest || [])].map((e) => logic.compileExpr(e, pageScope)).join(', ') : '';
          lines.push(`el_${id}.addEventListener('click', () => ${logic.actionRef(p.action)}(${arg}));`);
        }
        genDynamics(id, p);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Link: { // client-side navigation → <a href="/route"> (the history router intercepts the click)
        lines.push(`const el_${id} = document.createElement('a');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('link', p))};`);
        genInterpAttr(id, 'href', p.to ?? '/');  // static path or interpolated (`/product/{p.id}`)
        if (n.children && n.children.length) genChildren(id, `el_${id}`);          // children ⇒ a clickable card that navigates
        else if (p.label !== undefined) genInterpAttr(id, 'textContent', p.label);
        genDynamics(id, p);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Slot: { // the outlet in a shell where the router mounts the active page
        hasSlot = true;
        lines.push(`const __outlet = document.createElement('div');`);
        lines.push(`__outlet.className = 'muten-outlet';`);
        lines.push(`${parentVar}.appendChild(__outlet);`);
        break;
      }

      default:
        throw new Error('unsupported primitive: ' + n.type);
    }
  }

  // ── STATIC path: a page with NO reactivity compiles to plain HTML, zero runtime (Astro-like) ──
  const escHtml = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string): string => escHtml(s).replace(/"/g, '&quot;');
  const strOf = (v: StringPropValue | undefined): string => (typeof v === 'string' ? v : ''); // a static page carries only plain strings

  // Is this page fully static? — no reactive primitive, no reactive prop, no { } interpolation.
  function isStatic(): boolean {
    if (opts.format === Fmt.Store) return false;  // a store has no DOM; the shell is excluded by its `slot` (a reactive type)
    if ((doc.params || []).length) return false;  // a param page needs mount(app, params) — never the static path
    const reactiveType = new Set<string>([Nt.When, Nt.Each, Nt.Custom, Nt.Form, Nt.SearchField, Nt.DataTable, Nt.Slot]);
    const reactiveProp: Array<keyof NodeProps> = ['action', 'bind', 'submit', 'on', 'inputs', 'data'];
    const interpKeys: Array<keyof NodeProps> = ['value', 'src', 'alt', 'label', 'to'];
    for (const id of Object.keys(nodes)) {
      const n = nodes[id]; const p = n.props || {};
      if (reactiveType.has(n.type)) return false;
      if (reactiveProp.some((k) => p[k] !== undefined)) return false;
      if ((p.class || []).some((c) => typeof c !== 'string')) return false; // a reactive class toggle ⇒ not static
      if (interpKeys.some((k) => { const v = p[k]; return !!v && typeof v === 'object' && 'kind' in v && v.kind === Ek.Interp; })) return false;
    }
    return true;
  }

  // render a static node to an HTML string (recursively). Mirrors genNode's tags/classes, no JS.
  function renderStatic(id: string): string {
    const n = nodes[id]; const p = n.props || {};
    const kids = (): string => (nodes[id].children || []).map(renderStatic).join('');
    const cls = (base: string): string => ` class="${escAttr(classFor(base, p))}"`;
    const cont = CONTAINERS[n.type];
    if (cont) { const [tag, base] = cont; return `<${tag}${cls(base)}>${kids()}</${tag}>`; }
    switch (n.type) {
      case Nt.Text: return `<p${cls('text')}>${escHtml(strOf(p.value))}</p>`;
      case Nt.Span: return `<span${cls('span')}>${escHtml(strOf(p.value))}</span>`;
      case Nt.Title: { const lvl = p.level || 'h1'; return `<${lvl}${cls('title')}>${escHtml(strOf(p.value))}</${lvl}>`; }
      case Nt.Image: return `<img${cls('image')} src="${escAttr(strOf(p.src))}" alt="${escAttr(strOf(p.alt))}">`;
      case Nt.Link: return `<a${cls('link')} href="${escAttr(strOf(p.to) || '/')}">${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</a>`;
      case Nt.Button: return `<button${cls('button')}>${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</button>`;
      default: return '';
    }
  }

  // ── orchestrate: compile every piece, then hand them to the right emit target ──────────────
  const staticPage = opts.format === Fmt.Ssr ? false : isStatic(); // SSR always renders the tree (genNode) to serialize it
  // route params → local string consts read from the mount() argument (set by the router on match).
  const paramDecls = (doc.params || []).map((p) => `const ${p} = (__params || {})[${JSON.stringify(p)}] ?? '';`).join('\n  ');
  const stateDecls = logic.genState();
  const actionDecls = logic.genActions();
  // a store EXPORTS its gets (cross-module reads); a page declares them as locals inside mount() (`export` would be illegal there).
  const getKw = opts.format === Fmt.Store ? 'export const' : 'const';
  const getDecls = Object.entries(doc.gets || {}).map(([name, expr]) => `${getKw} ${name} = computed(() => ${logic.compileExpr(expr, pageScope)});`).join('\n');
  const effectDecls = logic.genEffects();

  let staticHtml: string | null = null;
  if (staticPage) staticHtml = rootId ? renderStatic(rootId) : '';            // populates usedTokens via classFor
  else if (opts.format !== Fmt.Store && rootId) genNode(rootId, 'app');        // a store has no DOM, only state + actions
  const renderBody = lines.join('\n  ');

  // which uuid fields to auto-fill per query, so mock/source rows don't need to carry ids.
  const queryUuids: { [query: string]: string[] } = {};
  for (const def of Object.values(state)) {
    if (typeof def.source === 'string' && def.source.startsWith('query:')) {
      const query = def.source.slice('query:'.length);
      const elem = (def.type.match(/^list<(.+)>$/) || [])[1];
      queryUuids[query] = elem ? logic.uuidFields(elem) : [];
    }
  }

  // emit CSS for only the tokens actually used (atomic, cacheable classes); a breakpoint token
  // (md:cols.3) is wrapped in its @media query.
  const tokenCss = [...usedTokens].map((token) => {
    const css = resolveToken(token, theme); if (!css) return '';
    const rule = `.${tokenClass(token)}{${css}}`;
    const colon = token.indexOf(':'); const bp = colon > 0 && theme.breakpoints[token.slice(0, colon)];
    return bp ? `@media (min-width:${bp}){${rule}}` : rule;
  }).filter(Boolean).join('\n');

  // host-written Custom components, inlined (each exposes `mount(el, props, on)`). The src is wrapped in an
  // IIFE, so strip `export` keywords — the natural/documented `export function mount` would otherwise be an
  // illegal `export` inside a function and break the whole module (a blank page).
  const componentDecls = Object.entries(components).map(([name, src]) =>
    `const __custom_${name} = (function () {\n${src.replace(/^[ \t]*export[ \t]+(default[ \t]+)?/gm, '')}\n  return mount;\n  })();`).join('\n\n  ');

  // a page imports only the store domains it actually referenced (collected into ctx.usedStores above).
  const storeImports = [...usedStores].map((domain) => `import * as __store_${domain} from 'virtual:muten/store/${domain}';`).join('\n');

  // `use a, b from "./lib.ts"` → a real ESM import of the named JS functions (the seam to the JS ecosystem).
  const externImports = (doc.imports || []).map((i) => `import { ${i.names.join(', ')} } from ${JSON.stringify(i.from)};`).join('\n');

  // page <head> meta: title/description from the `meta` block, with og:* auto-derived (one source, no DRY).
  const metaIn = doc.meta || {};
  const meta: { [k: string]: string } = { ...metaIn };
  if (metaIn.title && !meta['og:title']) meta['og:title'] = metaIn.title;
  if (metaIn.description && !meta['og:description']) meta['og:description'] = metaIn.description;

  const parts: EmitParts = {
    screen, tokenCss, projectCss, data, sources, api: opts.api || {}, meta, queryUuids,
    stateDecls, paramDecls, actionDecls, getDecls, effectDecls, componentDecls, storeImports, storeDecls: opts.storeCode || '', externImports,
    renderBody, staticHtml: staticHtml ?? '', hasSlot,
  };
  if (opts.format === Fmt.Store) return emitStore(parts);
  if (opts.format === Fmt.Ssr) return emitSsr(parts); // build-time pre-render factory (executed against a fake DOM)
  if (staticPage) return opts.format === Fmt.Module ? emitStatic(parts) : emitStaticHtml(parts);
  if (opts.format === Fmt.Module) return emitModule(parts);
  return emitHtml(parts);
}
