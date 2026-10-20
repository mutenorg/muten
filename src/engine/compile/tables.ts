// tables: the code of the structural blocks with native semantics: List (<ul>/<ol>, every child an <li>), Table
// (head rows in a real <thead>), Row, Cell (<th> in a head row), Details (the browser owns the toggle) and DataTable
// (rows from a list, keyed, with row actions).
import { Nt } from '#engine/shared/vocab.js';
import { parseClause } from '#engine/compile/helpers.js';
import type { Emitter, FlatNode, NodeEmitter } from '#engine/shared/types.js';

// semantic list: <ul> (or <ol> with `ordered`); every direct child becomes an <li>
function list(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, p.ordered ? 'ol' : 'ul', em.classFor('list', p));
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
  for (const childId of em.nodes[id].children || []) {
    if (em.nodes[childId].type === Nt.Each) em.genNode(childId, `el_${id}`);       // each row wraps itself in <li> (listItemEach)
    else { em.push(`const li_${childId} = document.createElement('li');`); em.genNode(childId, `li_${childId}`); em.push(`el_${id}.appendChild(li_${childId});`); }
  }
}

// native <table>: Row children group into a real <thead> (head rows) + <tbody> (the rest)
function table(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'table', em.classFor('table', p));
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
  const kids = em.nodes[id].children || [];
  const isHead = (k: string): boolean => em.nodes[k].type === Nt.Row && !!em.nodes[k].props?.head;
  const heads = kids.filter(isHead), body = kids.filter((k) => !isHead(k));
  if (heads.length) { em.push(`const thead_${id} = document.createElement('thead'); el_${id}.appendChild(thead_${id});`); for (const k of heads) em.genNode(k, `thead_${id}`); }
  if (body.length) { em.push(`const tbody_${id} = document.createElement('tbody'); el_${id}.appendChild(tbody_${id});`); for (const k of body) em.genNode(k, `tbody_${id}`); }
}

// <tr> inside a Table; its Cell children emit <td>/<th> straight into it
function row(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'tr', em.classFor('row', p));
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
  em.genChildren(id, `el_${id}`);
}

// <td> (or <th> if its Row is a header row) — text value OR rich children
function cell(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, em.headCells.has(id) ? 'th' : 'td', em.classFor('cell', p));
  if (n.children && n.children.length) em.genChildren(id, `el_${id}`);
  else if (p.value !== undefined) em.interpAttr(id, 'textContent', p.value);
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// native disclosure: <details> + <summary>, the browser owns the toggle (no JS, no state)
function details(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'details', em.classFor('details', p));
  if (p.open) em.push(`el_${id}.open = true;`);
  if (p.group) em.push(`el_${id}.name = ${JSON.stringify(p.group)};`); // one open at a time, native
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
  em.textEl(id + 's', 'summary', 'mu-summary', p.summary, `el_${id}`); // <summary> is the first child (the clickable header)
  em.genChildren(id, `el_${id}`);
}

function dataTable(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const dataSig = em.logic.bindSig(p.data);
  const dataExpr = em.queryStates.has(dataSig) ? `${dataSig}.get().data` : `${dataSig}.get()`;
  const columns = p.columns || [];
  const clauses = (p.where || []).map(parseClause);
  const staticExpr = clauses.filter((c) => !c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join(''); // pushed to the source (literal RHS)
  const dynExpr = clauses.filter((c) => c.dynamic).map((c) => `.filter((row) => ${c.expr})`).join('');      // applied reactively (@state RHS)
  const rowActions = n.children.map((cid) => em.nodes[cid]).filter((c) => c.type === Nt.RowAction);

  em.declEl(id, 'table', em.classFor('datatable', p));
  em.push(`const head_${id} = el_${id}.createTHead().insertRow();`);
  for (const col of columns) {
    em.push(`{ const th = document.createElement('th'); th.scope = 'col'; th.textContent = ${JSON.stringify(col)}; head_${id}.appendChild(th); }`); // a11y: scope ties data cells to their column header
  }
  if (rowActions.length) em.push(`{ const th = document.createElement('th'); th.scope = 'col'; head_${id}.appendChild(th); }`);
  em.push(`const body_${id} = el_${id}.createTBody();`);
  em.appendEl(id, parentVar);

  // one row -> a <tr>; `row` is the row signal, so each cell reacts to its data (granular:
  // a changed field rewrites only its <td>). RowAction args read the current row (`row.get()`).
  em.push(`function renderRow_${id}(row) {`);
  em.push(`  const tr = document.createElement('tr');`);
  for (const col of columns) {
    em.push(`  { const td = document.createElement('td'); effect(() => { td.textContent = (row.get()[${JSON.stringify(col)}] ?? ''); }); tr.appendChild(td); }`);
  }
  for (const ra of rowActions) {
    const rp = ra.props || {};
    const rowScope = { locals: new Set<string>(), sigLocals: new Set(['row']) };
    const arg = rp.arg !== undefined ? [rp.arg, ...(rp.argRest || [])].map((e) => em.logic.compileExpr(e, rowScope)).join(', ') : '';
    em.push(`  { const td = document.createElement('td'); const b = document.createElement('button'); b.type = 'button'; b.className = ${JSON.stringify(em.classFor('row-action', rp))}; b.textContent = ${JSON.stringify(rp.label)}; b.addEventListener('click', () => ${em.logic.actionRef(rp.action)}(${arg})); td.appendChild(b); tr.appendChild(td); }`);
  }
  em.push(`  return tr;`);
  em.push(`}`);

  // Keyed reconciliation (same engine as `each`): rows matched by id, reused/moved/disposed, never a full rebuild.
  em.push(`function base_${id}() { const __l = ${dataExpr}; return (Array.isArray(__l) ? __l : [])${staticExpr}; }`);   // fail-closed: a non-array never crashes the table
  em.push(`const start_${id} = document.createComment('rows');`);
  em.push(`const anchor_${id} = document.createComment('/rows');`);
  em.push(`body_${id}.appendChild(start_${id}); body_${id}.appendChild(anchor_${id});`);
  em.push(`const map_${id} = new Map();`);
  em.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });`);
  em.push(`let order_${id} = [];`);
  em.push(`effect(() => {`);
  em.push(`  const __rows = base_${id}()${dynExpr};`);
  em.push(`  const __seen = new Set(); const __next = []; const __twins = new Map();`);
  em.push(`  for (const __row of __rows) {`);
  em.push(`    const __k = __rowKey(__row, __twins); __seen.add(__k);`);   // by id, else by content (runtime-key.ts)
  em.push(`    let __e = map_${id}.get(__k);`);
  em.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }`);
  em.push(`    else { const __sig = signal(__row); const __r = root(() => [renderRow_${id}(__sig)]); __e = { sig: __sig, nodes: __r.value, dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }`);
  em.push(`    __next.push(__e);`);
  em.push(`  }`);
  em.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }`);
  em.push(`  __order(anchor_${id}.parentNode, anchor_${id}, __next, order_${id}); order_${id} = __next;`);
  em.push(`});`);
}

/** How each node type here becomes DOM code. */
export const TABLES_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.List, list], [Nt.Table, table], [Nt.Row, row], [Nt.Cell, cell], [Nt.Details, details], [Nt.DataTable, dataTable]]);
