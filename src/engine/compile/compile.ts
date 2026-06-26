// compile.ts: IR -> runnable code. The DOM half of the compiler.
// Walks the flat node tree and emits imperative DOM construction + fine-grained effects (text
// interpolation, when/each, DataTable, Form). No virtual DOM: the abstraction compiles away.
// Behaviour (expressions, action statements, state/action/effect decls) lives in logic.ts;
// output templates (HTML/module/store wrappers) live in emit.ts. compile() orchestrates all three.
// Static filters (role == admin) are pushed to the query; dynamic ones (name contains @q) stay
// reactive. A page with no reactivity compiles to plain HTML with zero runtime (Astro-like).

import { Nt, Ek, Fmt, Fk } from '#engine/shared/vocab.js';
import { customValue, CONTAINERS, parseClause, editableFields } from '#engine/compile/helpers.js';
import { emitStore, emitStatic, emitStaticHtml, emitSsr, emitModule, emitHtml } from '#engine/compile/emit.js';
import { Logic } from '#engine/compile/logic.js';
import type {
  Doc, NodeProps, Scope, Interp, StringPropValue, Value,
  CompileOpts, CompileCtx, EditableField, FieldConstraint, StoreInput, EmitParts,
} from '#engine/shared/types.js';

// Emit a .muten page as an ESM module (for the Vite pipeline): exports mount(root) + css.
// opts.stores lets the page reference app-global store domains.
export function compileModule(doc: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  return compile(doc, data, projectCss, components, sources, { ...opts, format: Fmt.Module });
}

// Emit one .store domain slice (state + get + actions + effects) as a shared ESM module.
export function compileStore(input: StoreInput = {}, data: { [name: string]: Value } = {}, sources: { [name: string]: Value } = {}): string {
  const { state = {}, gets = {}, actions = {}, effects = [], entities = {}, imports = [] } = input;
  return compile({ screen: 'store', entities, state, actions, gets, effects, imports, consts: {}, constraints: {}, rootId: undefined, nodes: {} }, data, '', {}, sources, { format: Fmt.Store });
}

export function compile(doc: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  const { nodes, rootId, state, entities, screen } = doc;

  let lines: string[] = [];
  let hasSlot = false; // a shell with `slot` returns its outlet from mount() so the router can target it

  // run a callback against a fresh buffer and return the lines it emitted: captures when/each bodies
  // into their own mount functions before splicing them back at runtime.
  const capture = (emit: () => void): string[] => { const saved = lines; lines = []; emit(); const out = lines; lines = saved; return out; };

  // class() = raw CSS classes passed straight through (the one styling path).
  const classFor = (base: string, props: NodeProps): string => {
    // conditional class (`name when cond`) is omitted here and toggled reactively by genDynamics.
    // Every primitive's base class is `mu-`-prefixed so muten NEVER collides with a CSS framework or
    // your own classes (a framework may ship its own .stack/.card/…); your look goes through class().
    return ['mu-' + base, ...(props.class || []).filter((c): c is string => typeof c === 'string')].join(' ');
  };

  // Shared compile context + the behaviour compiler that reads it (see logic.ts). `usedStores`
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
  const pageScope: Scope = { locals: new Set() }; // page-level scope for interpolation, when/each

  // reactive element bits: conditional classes (`class(active when cond)`) + events (`on(keydown: fn)`).
  const genDynamics = (id: string, p: NodeProps): void => {
    for (const c of p.class || []) if (typeof c !== 'string') {
      if ('interp' in c) {
        // `class("status-{x}")` — interpolated token, applied reactively: swap the previous computed token(s)
        // for the new whenever the value changes (split() so a multi-word result is handled token-by-token).
        const js = c.interp.parts.map((pt) => typeof pt === 'string' ? JSON.stringify(pt) : `String(${logic.compileExpr(pt, pageScope)})`).join(' + ');
        lines.push(`{ let __cp = ''; effect(() => { const __c = ${js}; if (__c === __cp) return; if (__cp) el_${id}.classList.remove(...__cp.split(' ').filter(Boolean)); if (__c) el_${id}.classList.add(...__c.split(' ').filter(Boolean)); __cp = __c; }); }`);
        continue;
      }
      // `class("a b c" when cond)` may hold MULTIPLE tokens; classList.toggle rejects a token with
      // spaces, so split (at compile time) and toggle each with the condition computed once.
      const toggles = c.name.trim().split(/\s+/).map((t) => `el_${id}.classList.toggle(${JSON.stringify(t)}, __on);`).join(' ');
      lines.push(`effect(() => { const __on = !!(${logic.compileExpr(c.cond, pageScope)}); ${toggles} });`);
    }
    for (const [event, act] of Object.entries(p.on || {})) {
      if (typeof act !== 'string') continue;
      if (event === 'enter') lines.push(`el_${id}.addEventListener('keydown', (e) => { if (e.key === 'Enter') ${logic.actionRef(act)}(); });`); // synthetic: Enter key only
      else lines.push(`el_${id}.addEventListener(${JSON.stringify(event)}, () => ${logic.actionRef(act)}());`);
    }
    // aria(...) — author-expressed accessibility: `key` → `aria-<key>` (`role` → `role`). A literal value is a
    // static attribute; a value that reads state is wrapped in an effect, so e.g. `aria(expanded: open)` stays in sync.
    for (const [key, expr] of Object.entries(p.aria || {})) {
      const attr = key === 'role' ? 'role' : 'aria-' + key;
      const val = logic.compileExpr(expr, pageScope);
      if (expr.kind === Ek.Lit) lines.push(`el_${id}.setAttribute(${JSON.stringify(attr)}, String(${val}));`);
      else lines.push(`effect(() => el_${id}.setAttribute(${JSON.stringify(attr)}, String(${val})));`);
    }
    // style(name: "..") → CSS custom property `--name`, reactive when the value interpolates state. Bounded to
    // CSS variables only (muten prepends `--`), so it never competes with class()/Tailwind; CSS reads var(--name).
    for (const [name, sv] of Object.entries(p.styleVars || {})) {
      const prop = JSON.stringify('--' + name.replace(/^-+/, ''));
      if (typeof sv === 'string') { lines.push(`el_${id}.style.setProperty(${prop}, ${JSON.stringify(sv)});`); continue; }
      const js = sv.parts.map((pt) => typeof pt === 'string' ? JSON.stringify(pt) : `String(${logic.compileExpr(pt, pageScope)})`).join(' + ');
      lines.push(`effect(() => el_${id}.style.setProperty(${prop}, ${js}));`);
    }
  };

  const genChildren = (id: string, parentVar: string): void => {
    for (const childId of nodes[id].children) genNode(childId, parentVar);
  };

  // interpolation parts joined into a JS string expression: "Hi, " + String(name ?? '') + ...
  const interpConcat = (value: Interp): string =>
    value.parts.map((part) => typeof part === 'string' ? JSON.stringify(part) : `String(${logic.compileExpr(part, pageScope)} ?? '')`).join(' + ');

  // text-bearing primitives (Text/Span/Title): plain string or a (possibly reactive) interpolation.
  function genTextEl(id: string, tag: string, className: string, value: StringPropValue | undefined, parentVar: string): void {
    lines.push(`const el_${id} = document.createElement('${tag}');`);
    lines.push(`el_${id}.className = ${JSON.stringify(className)};`);
    if (typeof value === 'string') {
      lines.push(`el_${id}.textContent = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const concat = interpConcat(value);
      const reactive = value.parts.some((part) => typeof part !== 'string'); // an embedded {expr} -> wrap in an effect
      lines.push(reactive ? `effect(() => { el_${id}.textContent = ${concat}; });` : `el_${id}.textContent = ${concat};`);
    }
    lines.push(`${parentVar}.appendChild(el_${id});`);
  }

  // set an attribute from a plain string or a (possibly reactive) interpolation (Image src/alt, labels)
  function genInterpAttr(id: string, attr: string, value: StringPropValue | undefined): void {
    if (typeof value === 'string') {
      lines.push(`el_${id}.${attr} = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const concat = interpConcat(value);
      const reactive = value.parts.some((part) => typeof part !== 'string');
      lines.push(reactive ? `effect(() => { el_${id}.${attr} = ${concat}; });` : `el_${id}.${attr} = ${concat};`);
    }
  }

  // Emit one node + its subtree into `parentVar`. Semantic containers share one generic path;
  // every other primitive has a case below. Logic (refs, exprs, actions) is delegated to `logic`.
  function genNode(id: string, parentVar: string): void {
    const n = nodes[id];
    const p = n.props || {};
    const cont = CONTAINERS[n.type]; // regions (Header/Nav/...) + Stack: [tag, baseClass]
    if (cont) {
      const [tag, base] = cont;
      lines.push(`const el_${id} = document.createElement('${tag}');`);
      lines.push(`el_${id}.className = ${JSON.stringify(classFor(base, p))};`);
      if (n.type === Nt.Nav && typeof p.label === 'string') lines.push(`el_${id}.setAttribute('aria-label', ${JSON.stringify(p.label)});`);
      // a11y by default (compiler-emitted): <main> is the focus target on navigation + the skip-link anchor.
      if (n.type === Nt.Page) lines.push(`el_${id}.id = 'mu-main'; el_${id}.tabIndex = -1;`);
      // a11y by default: a keyboard skip-link as the shell's first child, so Tab jumps past the chrome to content.
      if (n.type === Nt.Shell) lines.push(`{ const sk = document.createElement('a'); sk.href = '#mu-main'; sk.className = 'mu-skip-link'; sk.textContent = 'Skip to content'; el_${id}.appendChild(sk); }`);
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
        lines.push(`el_${id}.setAttribute('aria-label', ${JSON.stringify(typeof p.placeholder === 'string' && p.placeholder ? p.placeholder : 'Search')});`); // a11y: an accessible name (a placeholder is not one)
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('search', p))};`);
        genInterpAttr(id, 'placeholder', p.placeholder); // static OR interpolated ("Message #{channel}" stays reactive)
        lines.push(`effect(() => { if (el_${id}.value !== ${sig}.get()) el_${id}.value = ${sig}.get(); });`); // two-way: state->input so `.reset()` clears the box; guarded to avoid yanking the caret
        lines.push(`el_${id}.addEventListener('input', (e) => ${sig}.set(e.target.value));`);
        genDynamics(id, p); // wire on(enter: send) / on(...) + conditional class on the input
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.DataTable: {
        const dataSig = logic.bindSig(p.data);
        const dataExpr = queryStates.has(dataSig) ? `${dataSig}.get().data` : `${dataSig}.get()`;
        const columns = p.columns || [];
        const clauses = (p.where || []).map(parseClause);
        const staticExpr = clauses.filter((c) => !c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join(''); // pushed to the source (literal RHS)
        const dynExpr = clauses.filter((c) => c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join('');      // applied reactively (@state RHS)
        const rowActions = n.children.map((cid) => nodes[cid]).filter((c) => c.type === Nt.RowAction);

        lines.push(`const el_${id} = document.createElement('table');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('datatable', p))};`);
        lines.push(`const head_${id} = el_${id}.createTHead().insertRow();`);
        for (const col of columns) {
          lines.push(`{ const th = document.createElement('th'); th.scope = 'col'; th.textContent = ${JSON.stringify(col)}; head_${id}.appendChild(th); }`); // a11y: scope ties data cells to their column header
        }
        if (rowActions.length) lines.push(`{ const th = document.createElement('th'); th.scope = 'col'; head_${id}.appendChild(th); }`);
        lines.push(`const body_${id} = el_${id}.createTBody();`);
        lines.push(`${parentVar}.appendChild(el_${id});`);

        // one row -> a <tr>; `row` is the row signal, so each cell reacts to its data (granular:
        // a changed field rewrites only its <td>). RowAction args read the current row (`row.get()`).
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

        // Keyed reconciliation (same engine as `each`): rows matched by id, reused/moved/disposed, never a full rebuild.
        lines.push(`function base_${id}() { const __l = ${dataExpr}; return (Array.isArray(__l) ? __l : [])${staticExpr}; }`);   // fail-closed: a non-array never crashes the table
        lines.push(`const start_${id} = document.createComment('rows');`);
        lines.push(`const anchor_${id} = document.createComment('/rows');`);
        lines.push(`body_${id}.appendChild(start_${id}); body_${id}.appendChild(anchor_${id});`);
        lines.push(`const map_${id} = new Map();`);
        lines.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });   // parent unmount: tear down every row`);
        lines.push(`let order_${id} = [];`);
        lines.push(`effect(() => {`);
        lines.push(`  const __rows = base_${id}()${dynExpr};`);
        lines.push(`  const __seen = new Set(); const __next = [];`);
        lines.push(`  for (const __row of __rows) {`);
        lines.push(`    const __k = __row?.id ?? __row; __seen.add(__k);   // key by id (entities) or the value itself (scalars), never index`);
        lines.push(`    let __e = map_${id}.get(__k);`);
        lines.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }`);
        lines.push(`    else { const __sig = signal(__row); const __r = root(() => [renderRow_${id}(__sig)]); __e = { sig: __sig, nodes: __r.value, dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }`);
        lines.push(`    __next.push(__e);`);
        lines.push(`  }`);
        lines.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }`);
        lines.push(`  __order(anchor_${id}.parentNode, anchor_${id}, __next, order_${id}); order_${id} = __next;   // minimal DOM moves via LIS`);
        lines.push(`});`);
        break;
      }

      case Nt.Form: {
        const sig = logic.bindSig(p.bind);
        const entityName = state[sig]?.type; // validate rejects a non-local/non-entity bind; guard so a gap never throws a raw TypeError
        if (!entityName || !entities[entityName]) throw new Error(`Form must bind a page-local entity draft, not "${p.bind}"`);
        const fields = editableFields(entities[entityName]);
        const fc = (doc.constraints || {})[entityName] || {}; // per-field validation constraints from the entity schema

        lines.push(`const el_${id} = document.createElement('form');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('form', p))};`);
        lines.push(`{ const t = document.createElement('div'); t.className = 'mu-form-title'; t.textContent = ${JSON.stringify('New ' + entityName)}; el_${id}.appendChild(t); }`);

        const fieldVars: Array<EditableField & { var: string; c?: FieldConstraint }> = [];
        for (const f of fields) {
          const fv = `f_${id}_${f.name}`;
          const grp = `g_${fv}`;
          const labelText = f.name.charAt(0).toUpperCase() + f.name.slice(1); // a11y: a real label, never just a placeholder
          fieldVars.push({ ...f, var: fv, c: fc[f.name] });
          // a11y BY DEFAULT (compiler-emitted, the author writes nothing): every field is a group =
          // <label for=id> + the control + its error, with id/for paired and the error linked back.
          lines.push(`const ${grp} = document.createElement('div'); ${grp}.className = 'mu-field-group';`);
          lines.push(`{ const lb = document.createElement('label'); lb.className = 'mu-label'; lb.htmlFor = ${JSON.stringify(fv)}; lb.textContent = ${JSON.stringify(labelText)}; ${grp}.appendChild(lb); }`);
          if (f.kind === Fk.Enum) {
            lines.push(`const ${fv} = document.createElement('select');`);
            lines.push(`${fv}.className = 'mu-field';`);
            for (const opt of f.options) {
              lines.push(`{ const o = document.createElement('option'); o.value = ${JSON.stringify(opt)}; o.textContent = ${JSON.stringify(opt)}; ${fv}.appendChild(o); }`);
            }
          } else if (f.kind === Fk.Bool) {
            lines.push(`const ${fv} = document.createElement('input');`);
            lines.push(`${fv}.type = 'checkbox';`);
            lines.push(`${fv}.className = 'mu-field-check';`);
          } else {
            lines.push(`const ${fv} = document.createElement('input');`);
            lines.push(`${fv}.type = ${JSON.stringify(f.kind === Fk.Email ? 'email' : f.kind === Fk.Number ? 'number' : 'text')};`);
            lines.push(`${fv}.className = 'mu-field';`);
            lines.push(`${fv}.placeholder = ${JSON.stringify(f.name)};`);
          }
          lines.push(`${fv}.id = ${JSON.stringify(fv)};`);                                         // matches the label's htmlFor
          if (fc[f.name]?.required) lines.push(`${fv}.setAttribute('aria-required', 'true');`);   // SR announces the field is required
          // each edit patches the draft's sub-field immutably so the reflect effect re-runs.
          // Checkbox stores `checked` boolean; number coerces via Number(), else value is a raw string.
          if (f.kind === Fk.Bool) lines.push(`${fv}.addEventListener('change', (e) => ${sig}.set({ ...${sig}.get(), ${JSON.stringify(f.name)}: e.target.checked }));`);
          else {
            const val = f.kind === Fk.Number ? '(Number(e.target.value) || 0)' : 'e.target.value';
            lines.push(`${fv}.addEventListener('input', (e) => ${sig}.set({ ...${sig}.get(), ${JSON.stringify(f.name)}: ${val} }));`);
          }
          lines.push(`${grp}.appendChild(${fv});`);
          // error span: linked to its input via aria-describedby + announced live (a11y by default). Email
          // fields always get one (they now validate format even without an explicit constraint).
          if (fc[f.name] || f.kind === Fk.Email) lines.push(`const err_${fv} = document.createElement('small'); err_${fv}.className = 'mu-field-error'; err_${fv}.id = ${JSON.stringify('err_' + fv)}; err_${fv}.setAttribute('aria-live', 'polite'); ${fv}.setAttribute('aria-describedby', ${JSON.stringify('err_' + fv)}); ${grp}.appendChild(err_${fv});`);
          lines.push(`el_${id}.appendChild(${grp});`);
        }

        lines.push(`{ const sb = document.createElement('button'); sb.type = 'submit'; sb.className = 'mu-submit'; sb.textContent = ${JSON.stringify(typeof p.submitLabel === 'string' ? p.submitLabel : 'Submit')}; el_${id}.appendChild(sb); }`);
        // submit: validate against schema constraints; only call the action when every field passes.
        const vChecks: string[] = [];
        for (const fv of fieldVars) {
          if (!fv.c && fv.kind !== Fk.Email) continue; // email always validates its format; others only if they carry a constraint
          const err = `err_${fv.var}`, val = `String(__d[${JSON.stringify(fv.name)}] ?? '')`;
          vChecks.push(`${err}.textContent = '';`);
          if (fv.c?.required) vChecks.push(fv.kind === Fk.Bool
            ? `if (!__d[${JSON.stringify(fv.name)}]) { ${err}.textContent = 'Required'; __ok = false; }`   // a required checkbox must be CHECKED (String(false) is truthy — the old guard let it through)
            : `if (!${val}.trim()) { ${err}.textContent = 'Required'; __ok = false; }`);
          // email type now ACTUALLY validates format (was cosmetic): a non-empty value must look like an email.
          if (fv.kind === Fk.Email) vChecks.push(`if (${val} && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(${val})) { ${err}.textContent = 'Enter a valid email'; __ok = false; }`);
          // `pattern:"<regex>"`: a non-empty value must match the author's regex (phone / zip / SKU / …).
          if (fv.c?.pattern) vChecks.push(`if (${val} && !new RegExp(${JSON.stringify(fv.c.pattern)}).test(${val})) { ${err}.textContent = 'Invalid format'; __ok = false; }`);
          // number field: min/max is a value bound; text field: min/max is a character-length bound.
          if (fv.c?.min != null) vChecks.push(fv.kind === Fk.Number
            ? `if (${val} !== '' && Number(${val}) < ${fv.c.min}) { ${err}.textContent = 'Min ${fv.c.min}'; __ok = false; }`
            : `if (${val} && ${val}.length < ${fv.c.min}) { ${err}.textContent = 'Min ${fv.c.min} characters'; __ok = false; }`);
          if (fv.c?.max != null) vChecks.push(fv.kind === Fk.Number
            ? `if (${val} !== '' && Number(${val}) > ${fv.c.max}) { ${err}.textContent = 'Max ${fv.c.max}'; __ok = false; }`
            : `if (${val}.length > ${fv.c.max}) { ${err}.textContent = 'Max ${fv.c.max} characters'; __ok = false; }`);
        }
        // pass the bound draft to the submit action: a `<- item` action receives it (the Form's point);
        // an action that reads the draft by name ignores the extra arg. Mirrors `Button -> a(x)`.
        if (vChecks.length) {
          lines.push(`el_${id}.addEventListener('submit', (e) => { e.preventDefault(); const __d = ${sig}.get(); let __ok = true; ${vChecks.join(' ')} if (__ok) ${logic.actionRef(p.submit)}(__d); });`);
        } else {
          lines.push(`el_${id}.addEventListener('submit', (e) => { e.preventDefault(); ${logic.actionRef(p.submit)}(${sig}.get()); });`);
        }

        // reflect the draft back into fields so `draft.reset()` clears the form for free.
        // The value-changed guard avoids yanking the caret of the field being typed.
        lines.push(`effect(() => {`);
        lines.push(`  const __d = ${sig}.get();`);   // __d (reserved prefix) so it never collides with a state literally named `d`
        for (const fv of fieldVars) {
          if (fv.kind === Fk.Bool) { lines.push(`  { const v = !!__d[${JSON.stringify(fv.name)}]; if (${fv.var}.checked !== v) ${fv.var}.checked = v; }`); continue; }
          const def = fv.kind === Fk.Enum ? JSON.stringify(fv.options[0]) : `''`;
          lines.push(`  { const v = __d[${JSON.stringify(fv.name)}] ?? ${def}; if (${fv.var}.value !== v) ${fv.var}.value = v; }`);
        }
        lines.push(`});`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Text: genTextEl(id, 'p', classFor('text', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Span: genTextEl(id, 'span', classFor('span', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Title: genTextEl(id, p.level || 'h1', classFor('title', p), p.value, parentVar); genDynamics(id, p); break; // level from keyword; <h1> default

      case Nt.Image: {
        lines.push(`const el_${id} = document.createElement('img');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('image', p))};`);
        genInterpAttr(id, 'src', p.src);
        genInterpAttr(id, 'alt', p.alt ?? ''); // alt required by the manifest; "" = decorative
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Icon: { // `Icon "set:name"` -> inline SVG resolved at build (Iconify); static name, no JS shipped
        const ref = typeof p.name === 'string' ? p.name : '';
        lines.push(`const el_${id} = document.createElement('span');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('icon', p))};`);
        lines.push(`el_${id}.setAttribute('aria-hidden', 'true');`); // a11y: icons are decorative by default; meaning lives in adjacent text
        lines.push(`el_${id}.innerHTML = ${JSON.stringify(opts.iconResolver ? opts.iconResolver(ref) : '')};`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        genDynamics(id, p);
        break;
      }

      case Nt.Video: {
        lines.push(`const el_${id} = document.createElement('video');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('video', p))};`);
        genInterpAttr(id, 'src', p.src);
        for (const f of p.flags || []) lines.push(`el_${id}.${f === 'playsinline' ? 'playsInline' : f} = true;`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        genDynamics(id, p);
        break;
      }

      case Nt.When: {
        // conditional render: effect mounts children when the condition becomes true, removes them
        // when it becomes false. Comment node is the stable insertion anchor.
        if (!p.cond) throw new Error('when without a condition');
        const condJS = logic.compileExpr(p.cond, pageScope);
        const body = capture(() => genChildren(id, '__p'));
        lines.push(`function build_${id}(__p) {`);
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const anchor_${id} = document.createComment('when');`);
        lines.push(`${parentVar}.appendChild(anchor_${id});`);
        lines.push(`let shown_${id} = null;   // { value: nodes, dispose } while mounted, else null: dispose kills block effects on unmount`);
        lines.push(`onCleanup(() => { if (shown_${id}) shown_${id}.dispose(); });   // parent unmount: tear down the mounted block too`);
        lines.push(`effect(() => {`);
        lines.push(`  if (${condJS}) {`);
        lines.push(`    if (!shown_${id}) { const __r = root(() => { const __f = document.createDocumentFragment(); build_${id}(__f); return [...__f.childNodes]; }); for (const __n of __r.value) anchor_${id}.parentNode.insertBefore(__n, anchor_${id}); shown_${id} = __r; }`);
        lines.push(`  } else if (shown_${id}) { shown_${id}.dispose(); for (const __n of shown_${id}.value) __n.remove(); shown_${id} = null; }`);
        lines.push(`});`);
        break;
      }

      case Nt.Each: {
        // Keyed reconciliation (fine-grained, no VDOM): each row is backed by a per-row signal.
        // The body's bindings read it, so only the changed binding updates, never a full rebuild.
        // Rows are matched by `id` (never index, that bleeds state), reused/moved in place, and
        // disposed (effects too) when they leave. Focus/scroll/inputs survive live updates.
        if (!p.list || !p.as) throw new Error('each without a list or item variable');
        const listJS = logic.compileExpr(p.list, pageScope);
        const filterJS = p.filter ? logic.compileExpr(p.filter, pageScope) : ''; // `where cond`: item var bare inside .filter
        // the body reads the row through its signal: compile refs as `<as>.get()` (restore scope after)
        const prevSig = pageScope.sigLocals;
        pageScope.sigLocals = new Set([...(prevSig || []), p.as]);
        const body = capture(() => genChildren(id, '__p'));
        pageScope.sigLocals = prevSig;
        lines.push(`function buildItem_${id}(__p, ${p.as}) {`); // ${p.as} is the row signal; body refs compiled as ${p.as}.get()
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const start_${id} = document.createComment('each');`);
        lines.push(`const anchor_${id} = document.createComment('/each');`);
        lines.push(`${parentVar}.appendChild(start_${id}); ${parentVar}.appendChild(anchor_${id});`);
        lines.push(`const map_${id} = new Map();   // row id -> { sig, nodes, dispose, data }`);
        lines.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });   // parent unmount: tear down every row (no leaked effects)`);
        lines.push(`let order_${id} = [];`);
        lines.push(`effect(() => {`);
        lines.push(`  const __l = ${listJS}; const __rows = (Array.isArray(__l) ? __l : [])${filterJS ? `.filter((${p.as}) => ${filterJS})` : ''};`);   // fail-closed: a non-array never crashes the loop (renders empty)
        lines.push(`  const __seen = new Set(); const __next = [];`);
        lines.push(`  for (const __row of __rows) {`);
        lines.push(`    const __k = __row?.id ?? __row; __seen.add(__k);   // key by id (entities) or the value itself (scalars), never index`);
        lines.push(`    let __e = map_${id}.get(__k);`);
        lines.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }   // same row, changed data: granular update`);
        lines.push(`    else { const __sig = signal(__row); const __r = root(() => { const __f = document.createDocumentFragment(); buildItem_${id}(__f, __sig); return [...__f.childNodes]; }); __e = { sig: __sig, nodes: __r.value, dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }   // new row`);
        lines.push(`    __next.push(__e);`);
        lines.push(`  }`);
        lines.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }   // gone: dispose effects + remove nodes`);
        lines.push(`  __order(anchor_${id}.parentNode, anchor_${id}, __next, order_${id}); order_${id} = __next;   // fewest DOM moves via LIS (a swap moves 2 nodes, not O(n))`);
        lines.push(`});`);
        break;
      }

      case Nt.Custom: {
        // escape hatch: mounts a host-written component (opaque to the IR), wired via inputs/on.
        lines.push(`const el_${id} = document.createElement('div');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('custom', p))};`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        const ins = Object.entries(p.inputs || {}).map(([k, v]) => `${JSON.stringify(k)}: ${customValue(v)}`).join(', ');
        const ons = Object.entries(p.on || {}).map(([ev, act]) => `${JSON.stringify(ev)}: (...__a) => ${logic.actionRef(typeof act === 'string' ? act : '')}(...__a)`).join(', ');
        // reactive inputs: if mount returns an updater fn, re-call it whenever a bound @state changes (the
        // effect only re-runs when an input actually reads a signal). A mount that returns nothing stays a
        // mount-time snapshot — backward compatible.
        lines.push(`if (typeof __custom_${p.component} === 'function') { const __u${id} = __custom_${p.component}(el_${id}, { ${ins} }, { ${ons} }); if (typeof __u${id} === 'function') effect(() => __u${id}({ ${ins} })); }`);
        break;
      }

      case Nt.Button: {
        lines.push(`const el_${id} = document.createElement('button');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('button', p))};`);
        if (n.children && n.children.length) genChildren(id, `el_${id}`);          // children -> clickable card
        else if (p.label !== undefined) genInterpAttr(id, 'textContent', p.label); // else static or interpolated label
        if (p.action) {
          const arg = p.arg !== undefined ? [p.arg, ...(p.argRest || [])].map((e) => logic.compileExpr(e, pageScope)).join(', ') : '';
          lines.push(`el_${id}.addEventListener('click', () => ${logic.actionRef(p.action)}(${arg}));`);
        }
        genDynamics(id, p);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Link: { // client-side navigation -> <a href="/route"> intercepted by the history router
        lines.push(`const el_${id} = document.createElement('a');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('link', p))};`);
        genInterpAttr(id, 'href', p.to ?? '/');  // static path or interpolated (/product/{p.id})
        if (n.children && n.children.length) genChildren(id, `el_${id}`);          // children -> clickable card that navigates
        else if (p.label !== undefined) genInterpAttr(id, 'textContent', p.label);
        genDynamics(id, p);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case Nt.Slot: { // outlet in a shell where the router mounts the active page
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

  // ── static path: a page with no reactivity compiles to plain HTML, zero runtime (Astro-like) ──
  const escHtml = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s: string): string => escHtml(s).replace(/"/g, '&quot;');
  const strOf = (v: StringPropValue | undefined): string => (typeof v === 'string' ? v : ''); // static pages carry only plain strings

  // Is this page fully static? No reactive primitive, reactive prop, or {} interpolation.
  function isStatic(): boolean {
    if (opts.format === Fmt.Store) return false;  // store has no DOM; shell excluded by its `slot` (reactive type)
    if ((doc.params || []).length) return false;  // a param page needs mount(app, params), never the static path
    const reactiveType = new Set<string>([Nt.When, Nt.Each, Nt.Custom, Nt.Form, Nt.SearchField, Nt.DataTable, Nt.Slot]);
    const reactiveProp: Array<keyof NodeProps> = ['action', 'bind', 'submit', 'on', 'inputs', 'data'];
    const interpKeys: Array<keyof NodeProps> = ['value', 'src', 'alt', 'label', 'to'];
    for (const id of Object.keys(nodes)) {
      const n = nodes[id]; const p = n.props || {};
      if (reactiveType.has(n.type)) return false;
      if (reactiveProp.some((k) => p[k] !== undefined)) return false;
      if ((p.class || []).some((c) => typeof c !== 'string')) return false; // reactive class toggle -> not static
      if ((p.aria && Object.keys(p.aria).length) || (p.styleVars && Object.keys(p.styleVars).length)) return false; // aria()/style() write attrs/CSS-vars at runtime via genDynamics -> the static HTML path would silently drop them
      if (interpKeys.some((k) => { const v = p[k]; return !!v && typeof v === 'object' && 'kind' in v && v.kind === Ek.Interp; })) return false;
    }
    return true;
  }

  // render a static node to an HTML string (recursively), mirroring genNode's tags/classes, no JS.
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
      case Nt.Icon: return `<span${cls('icon')}>${opts.iconResolver ? opts.iconResolver(strOf(p.name)) : ''}</span>`;
      case Nt.Video: return `<video${cls('video')} src="${escAttr(strOf(p.src))}"${(p.flags || []).map((f) => ` ${f}`).join('')}></video>`;
      case Nt.Link: return `<a${cls('link')} href="${escAttr(strOf(p.to) || '/')}">${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</a>`;
      case Nt.Button: return `<button${cls('button')}>${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</button>`;
      default: return '';
    }
  }

  // ── orchestrate: compile every piece, then hand to the right emit target ─────────────────
  const staticPage = opts.format === Fmt.Ssr ? false : isStatic(); // SSR always renders the tree (genNode) to serialize it
  // route params -> local string consts read from the mount() argument (set by the router on match).
  const paramDecls = (doc.params || []).map((p) => `const ${p} = (__params || {})[${JSON.stringify(p)}] ?? '';`).join('\n  ');
  const stateDecls = logic.genState();
  const actionDecls = logic.genActions();
  // a store exports its gets (cross-module reads); a page declares them as locals inside mount() (export is illegal there).
  const getKw = opts.format === Fmt.Store ? 'export const' : 'const';
  const getDecls = Object.entries(doc.gets || {}).map(([name, expr]) => `${getKw} ${name} = computed(() => ${logic.compileExpr(expr, pageScope)});`).join('\n');
  const effectDecls = logic.genEffects();

  let staticHtml: string | null = null;
  if (staticPage) staticHtml = rootId ? renderStatic(rootId) : '';            // populates usedTokens via classFor
  else if (opts.format !== Fmt.Store && rootId) genNode(rootId, 'app');        // store has no DOM, only state + actions
  const renderBody = lines.join('\n  ');

  // uuid fields to auto-fill per query, so mock/source rows don't need to carry ids.
  const queryUuids: { [query: string]: string[] } = {};
  for (const def of Object.values(state)) {
    if (typeof def.source === 'string' && def.source.startsWith('query:')) {
      const query = def.source.slice('query:'.length);
      const elem = (def.type.match(/^list<(.+)>$/) || [])[1];
      queryUuids[query] = elem ? logic.uuidFields(elem) : [];
    }
  }

  // host-written Custom components, inlined (each exposes `mount(el, props, on)`). Wrapped in an
  // IIFE, so `export` keywords are stripped: `export function mount` inside a function would be
  // an illegal export and break the whole module (blank page).
  const componentDecls = Object.entries(components).map(([name, src]) =>
    `const __custom_${name} = (function () {\n${src.replace(/^[ \t]*export[ \t]+(default[ \t]+)?/gm, '')}\n  return mount;\n  })();`).join('\n\n  ');

  // import only the store domains actually referenced (collected in ctx.usedStores).
  const storeImports = [...usedStores].map((domain) => `import * as __store_${domain} from 'virtual:muten/store/${domain}';`).join('\n');

  // `use a, b from "./lib.ts"` -> real ESM import of named JS functions (the seam to the JS ecosystem).
  const externImports = (doc.imports || []).map((i) => `import { ${i.names.join(', ')} } from ${JSON.stringify(i.from)};`).join('\n');

  // page <head> meta: title/description from the `meta` block; og:* auto-derived from them (one source).
  const metaIn = doc.meta || {};
  const meta: { [k: string]: string } = { ...metaIn };
  if (metaIn.title && !meta['og:title']) meta['og:title'] = metaIn.title;
  if (metaIn.description && !meta['og:description']) meta['og:description'] = metaIn.description;

  const parts: EmitParts = {
    screen, projectCss, data, sources, api: opts.api || {}, meta, queryUuids,
    stateDecls, paramDecls, actionDecls, getDecls, effectDecls, componentDecls, storeImports, storeDecls: opts.storeCode || '', externImports,
    renderBody, staticHtml: staticHtml ?? '', hasSlot,
  };
  if (opts.format === Fmt.Store) return emitStore(parts);
  if (opts.format === Fmt.Ssr) return emitSsr(parts); // build-time pre-render factory (runs against a fake DOM)
  if (staticPage) return opts.format === Fmt.Module ? emitStatic(parts) : emitStaticHtml(parts);
  if (opts.format === Fmt.Module) return emitModule(parts);
  return emitHtml(parts);
}
