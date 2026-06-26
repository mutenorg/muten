// helpers.ts: pure helpers and lookup tables for the compiler. No shared state.
// Kept out of compile.ts so that file stays focused on the codegen walk. Consumed by compile.ts and logic.ts.

import { Nt, BOp, Fk } from '#engine/shared/vocab.js';
import type { Entity, EditableField, ArgValue } from '#engine/shared/types.js';

// Custom input value: @state -> snapshot of the signal; otherwise the JSON literal.
export const customValue = (v: ArgValue): string =>
  (typeof v === 'string' && v.startsWith('@')) ? `${v.slice(1)}.get()`
    : JSON.stringify(typeof v === 'object' && '$lit' in v ? v.$lit : v);

// Semantic containers: primitive -> [HTML tag, base class]. One generic codegen path covers all
// regions (landmarks), so compile.ts doesn't need a case per region type. The base class is bare here;
// classFor() prepends `mu-` to EVERY primitive's base, so muten never collides with a framework class.
export const CONTAINERS: { [type: string]: [string, string] } = {
  [Nt.Shell]: ['div', 'shell'], [Nt.Header]: ['header', 'header'], [Nt.Nav]: ['nav', 'nav'],
  [Nt.Sidebar]: ['aside', 'sidebar'], [Nt.Footer]: ['footer', 'footer'],
  [Nt.Page]: ['main', 'page'], [Nt.Stack]: ['div', 'stack'], // Page maps to <main>, the content landmark
};

// Muten binary op -> JS operator. `contains` is special-cased to __has and omitted here.
export const JS_BINOP: { [op in BOp]?: string } = {
  [BOp.Eq]: '===', [BOp.Neq]: '!==', [BOp.Lt]: '<', [BOp.Gt]: '>', [BOp.Lte]: '<=', [BOp.Gte]: '>=',
  [BOp.And]: '&&', [BOp.Or]: '||', [BOp.Add]: '+', [BOp.Sub]: '-', [BOp.Mul]: '*', [BOp.Div]: '/',
};

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
    else fields.push({ name, kind: Fk.Text });
  }
  return fields;
}
