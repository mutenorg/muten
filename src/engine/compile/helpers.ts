// helpers.ts: pure helpers and lookup tables for the compiler. No shared state.
// Kept out of compile.ts so that file stays focused on the codegen walk. Consumed by compile.ts and logic.ts.

import { Nt, BOp, Fk } from '#engine/shared/vocab.js';
import type { Entity, EditableField, ArgValue, FlatNode, Value, ValueObject } from '#engine/shared/types.js';

// Custom input value: @state -> snapshot of the signal; otherwise the JSON literal.
export const customValue = (v: ArgValue): string =>
  (typeof v === 'string' && v.startsWith('@')) ? `${v.slice(1)}.get()`
    : JSON.stringify(typeof v === 'object' && '$lit' in v ? v.$lit : v);

// Semantic containers: primitive -> [HTML tag, base class]. One generic codegen path covers all
// regions (landmarks), so compile.ts doesn't need a case per region type. The base class is bare here;
// classFor() prepends `mu-` to EVERY primitive's base, so muten never collides with a framework class.
export const CONTAINERS: { [type: string]: [string, string] } = {
  [Nt.Shell]: ['div', 'shell'], [Nt.Layout]: ['div', 'layout'], [Nt.Header]: ['header', 'header'], [Nt.Nav]: ['nav', 'nav'],
  [Nt.Sidebar]: ['aside', 'sidebar'], [Nt.Footer]: ['footer', 'footer'],
  [Nt.Page]: ['main', 'page'], [Nt.Stack]: ['div', 'stack'], // Page maps to <main>, the content landmark
  [Nt.Section]: ['section', 'section'], [Nt.Article]: ['article', 'article'], // sectioning content (List is its own case: <ul>/<ol> + <li> children)
};

// Muten binary op -> JS operator. `contains` is special-cased to __has and omitted here.
export const JS_BINOP: { [op in BOp]?: string } = {
  [BOp.Eq]: '===', [BOp.Neq]: '!==', [BOp.Lt]: '<', [BOp.Gt]: '>', [BOp.Lte]: '<=', [BOp.Gte]: '>=',
  [BOp.And]: '&&', [BOp.Or]: '||', [BOp.Add]: '+', [BOp.Sub]: '-', [BOp.Mul]: '*', [BOp.Div]: '/',
};

// The comparisons where an ABSENT value (a field the row did not bring) reads as the zero of the literal it is
// compared with: `when d.mood == 0` was false for a row without `mood`, so its spot rendered empty.
export const ZERO_COMPARE: ReadonlySet<BOp> = new Set([BOp.Eq, BOp.Neq, BOp.Lt, BOp.Gt, BOp.Lte, BOp.Gte]);

// Parses a where() clause into an expr string and classifies it as static (literal) or dynamic (@state).
export function parseClause(clause: string): { dynamic: boolean; expr: string } {
  let op: 'contains' | 'eq';
  let left: string, right: string;
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
  // emit a static RHS with its natural JS type: `where(stock == 0)` must compare to the NUMBER 0, not "0"
  // (JSON.stringify everything -> `row.stock === "0"`, always false: the silent dead-filter bug).
  const literal = (s: string): string => (/^-?\d+(?:\.\d+)?$/.test(s) ? s : s === 'true' || s === 'false' ? s : JSON.stringify(s));
  const valueExpr = dynamic ? `${right.slice(1)}.get()` : literal(right);
  const field = JSON.stringify(left);
  const expr = op === 'eq'
    ? `row[${field}] === ${valueExpr}`
    : `String(row[${field}] ?? '').toLowerCase().includes(String(${valueExpr}).toLowerCase())`;
  return { dynamic, expr };
}

// Editable fields of an entity: excludes uuid fields (auto-managed, not user-editable).
export function editableFields(entity: Entity): EditableField[] {
  const fields: EditableField[] = [];
  for (const [name, type] of Object.entries(entity)) {
    if (type === 'uuid') continue;
    if (type.startsWith('enum:')) fields.push({ name, kind: Fk.Enum, options: type.slice(5).split('|') });
    else if (type === 'email') fields.push({ name, kind: Fk.Email });
    else if (type === 'number') fields.push({ name, kind: Fk.Number });
    else if (type === 'bool') fields.push({ name, kind: Fk.Bool });
    else if (type === 'date') fields.push({ name, kind: Fk.Date });
    else if (type === 'password') fields.push({ name, kind: Fk.Password });
    else if (type === 'textarea') fields.push({ name, kind: Fk.Textarea });
    else fields.push({ name, kind: Fk.Text });
  }
  return fields;
}

// the control-flow nodes a Row can hold its cells through (`Row head { each roles as r { Cell … } }`)
const CELL_WRAPPERS = new Set<string>([Nt.Each, Nt.When]);

/** Cell-ids under a header row (`Row head`), directly or through each/when: they render as <th>, not <td>. */
export function headCellIds(nodes: { [id: string]: FlatNode }): Set<string> {
  const heads = new Set<string>();
  const visit = (ids: string[]): void => {
    for (const id of ids) {
      const node = nodes[id];
      if (node.type === Nt.Cell) heads.add(id);
      else if (CELL_WRAPPERS.has(node.type)) visit(node.children || []);
    }
  };
  for (const id of Object.keys(nodes)) if (nodes[id].type === Nt.Row && nodes[id].props?.head) visit(nodes[id].children || []);
  return heads;
}

// seed rows need a stable id too: `push` auto-mints one but seeds didn't, so remove/update by id matched
// `undefined == undefined` (one move hit every row). Filled deterministically at compile time so SSR and CSR
// agree (a runtime __id() would mismatch on hydration).
export function withSeedIds(initial: Value, uuids: string[], name: string): Value {
  if (!Array.isArray(initial)) return initial;
  return initial.map((row, index): Value => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
    const filled: ValueObject = { ...row };
    for (const field of uuids) if (filled[field] === null || filled[field] === undefined) filled[field] = `${name}-${index}`;
    return filled;
  });
}
