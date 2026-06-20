// Compiler: FLAT IR -> a self-contained HTML with fine-grained reactivity.
//
// Decisions that embody the spec's thesis:
//  - NO Virtual DOM. We generate imperative DOM + effects that touch ONLY what depends
//    on the state that changed (surgical connections).
//  - where(): STATIC filters (role == admin) are "pushed to the query" (applied to the
//    source); DYNAMIC ones (name contains @search) stay reactive on the client.
//  - The output is code the browser runs directly: the abstraction disappears.
//
// Deferred on purpose: real async query (loading/error/stale), and do{}/onError rollback.

import { PALETTE, BASE, TOKENS, tokenClass } from './theme.js';

const stripAt = (s) => (typeof s === 'string' && s.startsWith('@')) ? s.slice(1) : s;

// a Custom input value: @state -> snapshot of the signal; otherwise the literal
const customValue = (v) => (typeof v === 'string' && v.startsWith('@')) ? `${v.slice(1)}.get()` : JSON.stringify(v);

// Parses a where() clause and classifies it as static (literal) or dynamic (@state).
function parseClause(clause) {
  let op, left, right;
  if (clause.includes(' contains ')) {
    op = 'contains';
    [left, right] = clause.split(' contains ').map((s) => s.trim());
  } else if (clause.includes('==')) {
    op = 'eq';
    [left, right] = clause.split('==').map((s) => s.trim());
  } else {
    throw new Error('unsupported where clause: ' + clause);
  }
  const dynamic = right.startsWith('@');
  const valueExpr = dynamic ? `${right.slice(1)}.get()` : JSON.stringify(right);
  const field = JSON.stringify(left);
  const expr = op === 'eq'
    ? `row[${field}] === ${valueExpr}`
    : `String(row[${field}] ?? '').toLowerCase().includes(String(${valueExpr}).toLowerCase())`;
  return { dynamic, expr };
}

// Editable fields of an entity (excludes the auto uuid).
function editableFields(entity) {
  const fields = [];
  for (const [name, type] of Object.entries(entity)) {
    if (type === 'uuid') continue;
    if (type.startsWith('enum:')) fields.push({ name, kind: 'enum', options: type.slice(5).split('|') });
    else if (type === 'email') fields.push({ name, kind: 'email' });
    else fields.push({ name, kind: 'text' });
  }
  return fields;
}

const RUNTIME = `// ── fine-grained signals runtime (~18 lines, no dependencies) ──
  let __current = null;
  function signal(value) {
    const subs = new Set();
    return {
      get() { if (__current) subs.add(__current); return value; },
      set(next) { if (next === value) return; value = next; for (const e of [...subs]) e(); },
    };
  }
  function effect(fn) {
    const run = () => { const prev = __current; __current = run; try { fn(); } finally { __current = prev; } };
    run();
  }`;

export function compile(doc, data = {}, projectCss = '', components = {}, sources = {}) {
  const { nodes, rootId, state, entities, actions, screen } = doc;
  let lines = [];
  // capture the lines a callback emits (for deferred children: when/each mount functions)
  const capture = (fn) => { const saved = lines; lines = []; fn(); const out = lines; lines = saved; return out; };

  // style(...) -> atomic classes; we track which tokens are used to emit only those
  const usedTokens = new Set();
  const classFor = (base, props) => {
    for (const t of (props.style || [])) usedTokens.add(t);
    return [base, ...(props.style || []).map(tokenClass)].join(' ');
  };

  const genChildren = (id, parentVar) => {
    for (const childId of nodes[id].children) genNode(childId, parentVar);
  };

  function genNode(id, parentVar) {
    const n = nodes[id];
    const p = n.props || {};
    switch (n.type) {
      case 'Page': {
        lines.push(`const el_${id} = document.createElement('div');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('page', p))};`);
        if (p.title) {
          lines.push(`const ttl_${id} = document.createElement('h1');`);
          lines.push(`ttl_${id}.textContent = ${JSON.stringify(p.title)};`);
          lines.push(`el_${id}.appendChild(ttl_${id});`);
        }
        lines.push(`${parentVar}.appendChild(el_${id});`);
        genChildren(id, `el_${id}`);
        break;
      }

      case 'SearchField': {
        const sig = stripAt(p.bind);
        lines.push(`const el_${id} = document.createElement('input');`);
        lines.push(`el_${id}.type = 'search';`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('search', p))};`);
        if (p.placeholder) lines.push(`el_${id}.placeholder = ${JSON.stringify(p.placeholder)};`);
        lines.push(`el_${id}.value = ${sig}.get();`);
        lines.push(`el_${id}.addEventListener('input', (e) => ${sig}.set(e.target.value));`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case 'DataTable': {
        const dataSig = stripAt(p.data);
        const dataExpr = queryStates.has(dataSig) ? `${dataSig}.get().data` : `${dataSig}.get()`;
        const columns = p.columns || [];
        const clauses = (p.where || []).map(parseClause);
        const staticExpr = clauses.filter((c) => !c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join('');
        const dynExpr = clauses.filter((c) => c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join('');
        const rowActions = n.children.map((cid) => nodes[cid]).filter((c) => c.type === 'RowAction');

        lines.push(`const el_${id} = document.createElement('table');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('datatable', p))};`);
        lines.push(`const head_${id} = el_${id}.createTHead().insertRow();`);
        for (const col of columns) {
          lines.push(`{ const th = document.createElement('th'); th.textContent = ${JSON.stringify(col)}; head_${id}.appendChild(th); }`);
        }
        if (rowActions.length) lines.push(`head_${id}.appendChild(document.createElement('th'));`);
        lines.push(`const body_${id} = el_${id}.createTBody();`);
        lines.push(`${parentVar}.appendChild(el_${id});`);

        // render a single row
        lines.push(`function renderRow_${id}(row) {`);
        lines.push(`  const tr = document.createElement('tr');`);
        for (const col of columns) {
          lines.push(`  { const td = document.createElement('td'); td.textContent = row[${JSON.stringify(col)}] ?? ''; tr.appendChild(td); }`);
        }
        for (const ra of rowActions) {
          const rp = ra.props || {};
          const arg = typeof rp.arg === 'string' && rp.arg.startsWith('row.')
            ? `row[${JSON.stringify(rp.arg.slice(4))}]`
            : JSON.stringify(rp.arg);
          lines.push(`  { const td = document.createElement('td'); const b = document.createElement('button'); b.className = ${JSON.stringify(classFor('row-action', rp))}; b.textContent = ${JSON.stringify(rp.label)}; b.addEventListener('click', () => ${rp.action}(${arg})); td.appendChild(b); tr.appendChild(td); }`);
        }
        lines.push(`  return tr;`);
        lines.push(`}`);

        // static filters -> "pushed to the query" (applied to the source)
        lines.push(`function base_${id}() { return ${dataExpr}${staticExpr}; }`);
        // effect: depends ONLY on ${dataSig} and the dynamic @refs of the where
        lines.push(`effect(() => {`);
        lines.push(`  const rows = base_${id}()${dynExpr};`);
        lines.push(`  body_${id}.replaceChildren(...rows.map(renderRow_${id}));`);
        lines.push(`});`);
        break;
      }

      case 'Form': {
        const sig = stripAt(p.bind);
        const entityName = state[sig].type;
        const fields = editableFields(entities[entityName]);

        lines.push(`const el_${id} = document.createElement('form');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('form', p))};`);
        lines.push(`{ const t = document.createElement('div'); t.className = 'form-title'; t.textContent = ${JSON.stringify('New ' + entityName)}; el_${id}.appendChild(t); }`);

        const fieldVars = [];
        for (const f of fields) {
          const fv = `f_${id}_${f.name}`;
          fieldVars.push({ ...f, var: fv });
          if (f.kind === 'enum') {
            lines.push(`const ${fv} = document.createElement('select');`);
            lines.push(`${fv}.className = 'field';`);
            for (const opt of f.options) {
              lines.push(`{ const o = document.createElement('option'); o.value = ${JSON.stringify(opt)}; o.textContent = ${JSON.stringify(opt)}; ${fv}.appendChild(o); }`);
            }
          } else {
            lines.push(`const ${fv} = document.createElement('input');`);
            lines.push(`${fv}.type = ${JSON.stringify(f.kind === 'email' ? 'email' : 'text')};`);
            lines.push(`${fv}.className = 'field';`);
            lines.push(`${fv}.placeholder = ${JSON.stringify(f.name)};`);
          }
          // binding: each keystroke updates the object's sub-field in the state
          lines.push(`${fv}.addEventListener('input', (e) => ${sig}.set({ ...${sig}.get(), ${JSON.stringify(f.name)}: e.target.value }));`);
          lines.push(`el_${id}.appendChild(${fv});`);
        }

        lines.push(`{ const sb = document.createElement('button'); sb.type = 'submit'; sb.className = 'submit'; sb.textContent = ${JSON.stringify(p.submitLabel || 'Submit')}; el_${id}.appendChild(sb); }`);
        lines.push(`el_${id}.addEventListener('submit', (e) => { e.preventDefault(); ${p.submit}(); });`);

        // effect: reflects ${sig} into the fields -> draft.reset() clears the form for free.
        // The guard avoids moving the cursor of the field being typed.
        lines.push(`effect(() => {`);
        lines.push(`  const d = ${sig}.get();`);
        for (const fv of fieldVars) {
          const def = fv.kind === 'enum' ? JSON.stringify(fv.options[0]) : `''`;
          lines.push(`  { const v = d[${JSON.stringify(fv.name)}] ?? ${def}; if (${fv.var}.value !== v) ${fv.var}.value = v; }`);
        }
        lines.push(`});`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case 'Stack': {
        lines.push(`const el_${id} = document.createElement('div');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('stack', p))};`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        genChildren(id, `el_${id}`);
        break;
      }

      case 'Text': {
        lines.push(`const el_${id} = document.createElement('p');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('text', p))};`);
        const v = p.value;
        if (typeof v === 'string') {
          lines.push(`el_${id}.textContent = ${JSON.stringify(v)};`);
        } else if (v && v.kind === 'interp') {
          // "Hi, {user.name}" → concat of literals + reactive refs; wrap in effect if any ref
          const concat = v.parts.map((part) =>
            typeof part === 'string' ? JSON.stringify(part) : `String(${compileExpr(part, pageScope)} ?? '')`).join(' + ');
          const reactive = v.parts.some((part) => typeof part !== 'string');
          lines.push(reactive ? `effect(() => { el_${id}.textContent = ${concat}; });` : `el_${id}.textContent = ${concat};`);
        } else if (v && v.kind) {
          lines.push(`effect(() => { el_${id}.textContent = String(${compileExpr(v, pageScope)} ?? ''); });`);
        }
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case 'Image': {
        lines.push(`const el_${id} = document.createElement('img');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('image', p))};`);
        const v = p.src;
        if (typeof v === 'string') {
          lines.push(`el_${id}.src = ${JSON.stringify(v)};`);
        } else if (v && v.kind === 'interp') {
          const concat = v.parts.map((part) => typeof part === 'string' ? JSON.stringify(part) : `String(${compileExpr(part, pageScope)} ?? '')`).join(' + ');
          const reactive = v.parts.some((part) => typeof part !== 'string');
          lines.push(reactive ? `effect(() => { el_${id}.src = ${concat}; });` : `el_${id}.src = ${concat};`);
        } else if (v && v.kind) {
          lines.push(`effect(() => { el_${id}.src = String(${compileExpr(v, pageScope)} ?? ''); });`);
        }
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      case 'When': {
        // conditional render: an effect mounts/unmounts the children before an anchor comment
        const condJS = compileExpr(p.cond, pageScope);
        const body = capture(() => genChildren(id, '__p'));
        lines.push(`function build_${id}(__p) {`);
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const anchor_${id} = document.createComment('when');`);
        lines.push(`${parentVar}.appendChild(anchor_${id});`);
        lines.push(`let shown_${id} = [];`);
        lines.push(`effect(() => {`);
        lines.push(`  if (${condJS}) {`);
        lines.push(`    if (!shown_${id}.length) { const __f = document.createDocumentFragment(); build_${id}(__f); shown_${id} = [...__f.childNodes]; anchor_${id}.parentNode.insertBefore(__f, anchor_${id}); }`);
        lines.push(`  } else if (shown_${id}.length) { for (const __n of shown_${id}) __n.remove(); shown_${id} = []; }`);
        lines.push(`});`);
        break;
      }

      case 'Each': {
        // list render: an effect rebuilds the items into a fragment whenever the list changes
        const listJS = compileExpr(p.list, pageScope);
        const body = capture(() => genChildren(id, '__p'));
        lines.push(`function buildItem_${id}(__p, ${p.as}) {`);
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const anchor_${id} = document.createComment('each');`);
        lines.push(`${parentVar}.appendChild(anchor_${id});`);
        lines.push(`let items_${id} = [];`);
        lines.push(`effect(() => {`);
        lines.push(`  for (const __n of items_${id}) __n.remove();`);
        lines.push(`  const __f = document.createDocumentFragment();`);
        lines.push(`  for (const ${p.as} of (${listJS} ?? [])) buildItem_${id}(__f, ${p.as});`);
        lines.push(`  items_${id} = [...__f.childNodes];`);
        lines.push(`  anchor_${id}.parentNode.insertBefore(__f, anchor_${id});`);
        lines.push(`});`);
        break;
      }

      case 'Custom': {
        // escape hatch: mount a host-written component, opaque to the IR, with declared inputs/on
        lines.push(`const el_${id} = document.createElement('div');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('custom', p))};`);
        lines.push(`${parentVar}.appendChild(el_${id});`);
        const ins = Object.entries(p.inputs || {}).map(([k, v]) => `${JSON.stringify(k)}: ${customValue(v)}`).join(', ');
        const ons = Object.entries(p.on || {}).map(([ev, act]) => `${JSON.stringify(ev)}: (...__a) => ${act}(...__a)`).join(', ');
        lines.push(`if (typeof __custom_${p.component} === 'function') __custom_${p.component}(el_${id}, { ${ins} }, { ${ons} });`);
        break;
      }

      case 'Button': {
        lines.push(`const el_${id} = document.createElement('button');`);
        lines.push(`el_${id}.className = ${JSON.stringify(classFor('button', p))};`);
        if (typeof p.label === 'string') lines.push(`el_${id}.textContent = ${JSON.stringify(p.label)};`);
        if (p.action) {
          const arg = p.arg !== undefined ? argExpr(p.arg) : '';
          lines.push(`el_${id}.addEventListener('click', () => ${p.action}(${arg}));`);
        }
        lines.push(`${parentVar}.appendChild(el_${id});`);
        break;
      }

      default:
        throw new Error('unsupported primitive: ' + n.type);
    }
  }

  function genState() {
    const out = [];
    for (const [name, def] of Object.entries(state)) {
      if (typeof def.source === 'string' && def.source.startsWith('query:')) {
        const q = def.source.slice('query:'.length);
        out.push(`const ${name} = query(${JSON.stringify(q)}); // async: ${name}.loading / .error / .data`);
      } else {
        out.push(`const ${name} = signal(${JSON.stringify(def.initial ?? null)});`);
      }
    }
    return out.join('\n  ');
  }

  // ── compiling the action BODIES (the logic comes from the .screen, not heuristics) ──
  const stateKeys = new Set(Object.keys(state));
  const pageScope = { locals: new Set() }; // page-level expressions (text interpolation, when)
  // query-backed states are RICH async signals: { data, loading, error }
  const queryStates = new Set(
    Object.entries(state).filter(([, d]) => typeof d.source === 'string' && d.source.startsWith('query:')).map(([n]) => n),
  );

  // uuid fields of an entity (auto-generated on push)
  function uuidFields(entityName) {
    const e = entities[entityName] || {};
    return Object.entries(e).filter(([, t]) => t === 'uuid').map(([k]) => k);
  }

  // resolves a reference by scope: lambda local | state (.get()) | action parameter
  function resolveRef(name, scope) {
    const [head, ...rest] = name.split('.');
    const tail = rest.length ? '.' + rest.join('.') : '';
    if (scope.locals.has(head)) return head + tail;           // u, e, ...
    if (queryStates.has(head)) {                              // rich query: .loading/.error or data
      if (rest[0] === 'loading' || rest[0] === 'error') return `${head}.get()${tail}`;
      return `${head}.get().data${tail}`;                     // @users -> data array; @users.length -> data.length
    }
    if (stateKeys.has(head)) return `${head}.get()` + tail;   // draft -> draft.get()
    return head + tail;                                        // input parameter (id)
  }

  function compileExpr(node, scope) {
    if (node.kind === 'lit') return JSON.stringify(node.value);
    if (node.kind === 'ref') return resolveRef(node.name, scope);
    if (node.kind === 'un') {
      const o = compileExpr(node.operand, scope);
      if (node.op === 'not') return `!(${o})`;
      throw new Error('unsupported unary: ' + node.op);
    }
    if (node.kind === 'bin') {
      const L = compileExpr(node.left, scope);
      const R = compileExpr(node.right, scope);
      if (node.op === 'contains') return `String(${L} ?? '').toLowerCase().includes(String(${R}).toLowerCase())`;
      const JS = { '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=', and: '&&', or: '||' };
      if (JS[node.op]) return `(${L} ${JS[node.op]} ${R})`;
      throw new Error('unsupported operator: ' + node.op);
    }
    throw new Error('unsupported expression');
  }

  // arrow-call arg: "t.id" -> item/row scope var; state -> .get(); else a bare name
  function argExpr(argStr) {
    if (typeof argStr !== 'string') return JSON.stringify(argStr);
    const [head, ...rest] = argStr.split('.');
    const tail = rest.length ? '.' + rest.join('.') : '';
    if (stateKeys.has(head)) return `${head}.get()${tail}`;
    return head + tail;
  }

  function genActions() {
    const out = [];
    for (const [name, a] of Object.entries(actions || {})) {
      const inputIsState = stateKeys.has(a.input);
      const scope = { locals: new Set(), input: a.input, inputIsState };
      // if the input is a state it's read from the signal; otherwise it's a parameter (e.g. id)
      out.push(`function ${name}(${inputIsState ? '' : a.input}) {`);
      for (const st of a.body || []) {
        if (st.op === 'reset') {
          out.push(`  ${st.target}.set(${JSON.stringify(state[st.target].initial ?? null)});`);
        } else if (st.op === 'set') {
          out.push(`  ${st.target}.set(${compileExpr(st.arg, scope)});`);
        } else if (st.op === 'push') {
          const elem = (state[st.target].type.match(/^list<(.+)>$/) || [])[1];
          const isEntity = elem && entities[elem]; // list<User> → entity; list<uuid>/list → scalar
          const wrap = (v) => queryStates.has(st.target) // query target: mutate .data inside { data, loading, error }
            ? `${st.target}.set({ ...${st.target}.get(), data: [...${st.target}.get().data, ${v}] });`
            : `${st.target}.set([...${st.target}.get(), ${v}]);`;
          if (isEntity) { // entity list: copy + auto-fill uuid fields
            out.push(`  { const __it = { ...${compileExpr(st.arg, scope)} };`);
            for (const f of uuidFields(elem)) out.push(`    if (__it.${f} === null || __it.${f} === undefined) __it.${f} = __id(); // auto uuid`);
            out.push(`    ${wrap('__it')} }`);
          } else { // scalar list (ids, numbers…): push the value as-is
            out.push(`  ${wrap(compileExpr(st.arg, scope))}`);
          }
        } else if (st.op === 'remove') {
          const inner = { ...scope, locals: new Set([...scope.locals, st.param]) };
          const pred = compileExpr(st.pred, inner);
          out.push(queryStates.has(st.target)
            ? `  ${st.target}.set({ ...${st.target}.get(), data: ${st.target}.get().data.filter((${st.param}) => !(${pred})) });`
            : `  ${st.target}.set(${st.target}.get().filter((${st.param}) => !(${pred})));`);
        } else {
          throw new Error('unsupported action op: ' + st.op);
        }
      }
      out.push(`}`);
    }
    return out.join('\n  ');
  }

  const stateDecls = genState();
  const actionDecls = genActions();
  genNode(rootId, 'app');
  const renderBody = lines.join('\n  ');

  // which uuid fields to auto-fill per query (so the mock doesn't need to carry ids)
  const queryUuids = {};
  for (const [, def] of Object.entries(state)) {
    if (typeof def.source === 'string' && def.source.startsWith('query:')) {
      const q = def.source.slice('query:'.length);
      const ent = (def.type.match(/^list<(.+)>$/) || [])[1];
      queryUuids[q] = ent ? uuidFields(ent) : [];
    }
  }

  // static CSS: only the tokens actually used (atomic, cacheable classes)
  const tokenCss = [...usedTokens].filter((t) => TOKENS[t]).map((t) => `.${tokenClass(t)}{${TOKENS[t]}}`).join('\n');

  // host-written Custom components, inlined (each exposes a `mount(el, props, on)`)
  const componentDecls = Object.entries(components).map(([name, src]) =>
    `const __custom_${name} = (function () {\n${src}\n  return mount;\n  })();`).join('\n\n  ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${screen}</title>
<style>
  /* engine: palette + base + used tokens */
  ${PALETTE}
  ${BASE}
  ${tokenCss}
  /* project: overrides the above via the cascade (bring-your-own-theme) */
  ${projectCss}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">
  ${RUNTIME}

  // ── dynamic ids (nothing hardcoded) ──
  let __seq = 0;
  function __id() { return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + (++__seq); }

  // ── data layer: a query is a RICH reactive signal { data, loading, error } ──
  // Fetches async (here a mock with a small delay so loading/error are visible). Swapping
  // __fetch for a real fetch needs a server → that's where a dev-server / Vite comes in.
  const __DATA = ${JSON.stringify(data)};
  const __SOURCES = ${JSON.stringify(sources)};
  const __UUIDS = ${JSON.stringify(queryUuids)};
  const __DELAY = 450; // simulated latency (mock only)
  const __fill = (name, rows) => {
    const ids = __UUIDS[name] || [];
    return rows.map((r) => { const o = { ...r }; for (const f of ids) if (o[f] === null || o[f] === undefined) o[f] = __id(); return o; });
  };
  function __fetch(name) {
    const s = __SOURCES[name];
    if (s) { // real API source
      const url = typeof s === 'string' ? s : s.url;
      const at = typeof s === 'string' ? null : s.at;
      return fetch(url).then((r) => r.json()).then((j) => __fill(name, at ? (j[at] ?? []) : (Array.isArray(j) ? j : [])));
    }
    return new Promise((res) => setTimeout(() => res(__fill(name, __DATA[name] ?? [])), __DELAY)); // mock
  }
  function query(name) {
    const sig = signal({ data: [], loading: true, error: null });
    __fetch(name).then((d) => sig.set({ data: d, loading: false, error: null }))
                 .catch((e) => sig.set({ data: [], loading: false, error: String(e) }));
    return sig;
  }

  // ── declared state (state from the IR) ──
  ${stateDecls}

  // ── actions (actions from the IR) ──
  ${actionDecls}

  // ── custom components (host-written, opaque to the IR) ──
  ${componentDecls}

  // ── render: imperative DOM + fine-grained effects ──
  const app = document.getElementById('app');
  ${renderBody}
</script>
</body>
</html>
`;
}
