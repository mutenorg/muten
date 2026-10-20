// icon-names: every name an `Icon "{…}"` can take, known at build. An icon is inlined as SVG (only the ones a page uses
// ship), so a name from data needs its possible values to be knowable. They are when it comes from
//   · a choice of names:            Icon "{done ? "lucide:check" : "lucide:circle"}"
//   · a prefix and a choice:        Icon "lucide:{open ? "chevron-up" : "chevron-down"}"
//   · a field of a list written in the page (and changed by no action), read in its `each`:
//       state { tabs = [ { label: "Inicio", icon: "lucide:house" }, … ] : list }
//       each tabs as tab { Icon "{tab.icon}" }
//   · a `const`.
// The compiler includes those icons and nothing else; a name it cannot know is an error that says how to write it.
import { Ek, BOp, Nt } from '#engine/shared/vocab.js';
import type { Doc, Expr, Interp, Value } from '#engine/shared/types.js';

const MAX_NAMES = 200;   // a choice that multiplies past this is not a closed set of icons any more

// each row variable -> the page lists it walks (a variable name reused by two `each` walks both)
function eachLists(doc: Doc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of Object.values(doc.nodes)) {
    const list = node.props?.list;
    if (node.type !== Nt.Each || !node.props?.as || !list || list.kind !== Ek.Ref) continue;
    out.set(node.props.as, [...(out.get(node.props.as) || []), list.name]);
  }
  return out;
}

const textOf = (value: Value | undefined): string | null => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null);

// the values a ref can hold, when the page itself spells them out
function refValues(name: string, doc: Doc, lists: Map<string, string[]>): string[] | null {
  const [head, field, ...deeper] = name.split('.');
  if (!field) { const value = textOf(doc.consts?.[head]); return value === null ? null : [value]; }
  const walked = lists.get(head);
  if (!walked || deeper.length) return null;
  const values: string[] = [];
  for (const list of walked) {
    const def = doc.state?.[list];
    const initial = def?.initial;
    // only a list the page writes and nothing changes: an empty one, a query, or one an action pushes to holds names from elsewhere
    const changed = Object.values(doc.actions || {}).some((action) => action.mutates.includes(list));
    if (!Array.isArray(initial) || !initial.length || def?.source || changed) return null;
    for (const row of initial) {
      const value = row && typeof row === 'object' && !Array.isArray(row) ? textOf(row[field]) : null;
      if (value === null) return null;
      values.push(value);
    }
  }
  return values;
}

function exprValues(expr: Expr, doc: Doc, lists: Map<string, string[]>): string[] | null {
  switch (expr.kind) {
    case Ek.Lit: { const value = textOf(expr.value ?? undefined); return value === null ? null : [value]; }
    case Ek.Ref: return refValues(expr.name, doc, lists);
    case Ek.Tern: { const then = exprValues(expr.then, doc, lists); const otherwise = exprValues(expr.else, doc, lists); return then && otherwise ? [...then, ...otherwise] : null; }
    case Ek.Bin: return expr.op === BOp.Add ? product([exprValues(expr.left, doc, lists), exprValues(expr.right, doc, lists)]) : null;
    default: return null;
  }
}

function product(choices: Array<string[] | null>): string[] | null {
  let out = [''];
  for (const choice of choices) {
    if (!choice) return null;
    out = out.flatMap((before) => choice.map((after) => before + after));
    if (out.length > MAX_NAMES) return null;
  }
  return out;
}

/** Every name the interpolated Icon name can take, or null when the page does not spell them out. */
export function iconNames(name: Interp, doc: Doc): string[] | null {
  const lists = eachLists(doc);
  const names = product(name.parts.map((part) => (typeof part === 'string' ? [part] : exprValues(part, doc, lists))));
  return names ? [...new Set(names)] : null;
}
