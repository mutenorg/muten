// a11y: what a screen reader needs from a page that the compiler cannot supply on its own, checked by `muten check`.
// Warnings, never errors: the page still works, it just cannot be used by everyone.
//   · field-unnamed     a field with no text has no name (a placeholder alone is not one)
//   · control-unnamed   a Button or Link made only of icons announces nothing (an Icon is aria-hidden)
//   · heading-many-h1   one h1 says what the page is; `Title` is an h1 unless it says otherwise
import { diag } from '#engine/shared/diagnostics.js';
import { Nt } from '#engine/shared/vocab.js';
import type { Diagnostic, FlatNode, NodeProps } from '#engine/shared/types.js';

/** Fields whose accessible name is their text. */
const NAMED_FIELDS: ReadonlySet<string> = new Set([Nt.SearchField, Nt.Textarea, Nt.Password, Nt.Select, Nt.Date, Nt.Number, Nt.Range]);
/** Nodes that are words on screen. */
const TEXT_NODES: ReadonlySet<string> = new Set([Nt.Text, Nt.Span, Nt.Title]);
/** Nodes whose children are on screen only sometimes (a branch, a row); `match` and `else` are Whens by now. */
const CONDITIONAL: ReadonlySet<string> = new Set([Nt.When, Nt.Each]);

const named = (props: NodeProps): boolean => !!(props.aria?.label || props.aria?.labelledby);

/** The accessibility warnings of a page's nodes. */
export function a11yDiagnostics(nodes: { [id: string]: FlatNode }): Diagnostic[] {
  const out: Diagnostic[] = [];
  // does this subtree put words on screen (or name itself)?
  const speaks = (id: string): boolean => {
    const n = nodes[id];
    if (!n) return false;
    if (TEXT_NODES.has(n.type) && n.props.value !== undefined && n.props.value !== '') return true;
    if (n.type === Nt.Image && n.props.alt) return true;
    return named(n.props) || (n.children || []).some(speaks);
  };
  for (const n of Object.values(nodes)) {
    if (NAMED_FIELDS.has(n.type) && !n.props.placeholder && !named(n.props))
      out.push(diag('field-unnamed', `this ${n.type} has no name a screen reader can say: give it its text (\`${n.type} bind(…) "Cantidad"\`) or \`aria(label: "…")\` when a visible label sits next to it.`, { loc: n.loc, severity: 'warning' }));
    if ((n.type === Nt.Button || n.type === Nt.Link) && n.children?.length && !n.props.label && !named(n.props) && !n.children.some(speaks))
      out.push(diag('control-unnamed', `this ${n.type} shows only an icon, so a screen reader announces it with no name: add \`aria(label: "Cerrar")\` (or words inside it).`, { loc: n.loc, severity: 'warning' }));
  }
  // only the Titles always on screen count: the steps of a flow (`when step == 1 { Title … }`) are never there together
  const parentOf = new Map<string, string>();
  for (const [id, n] of Object.entries(nodes)) for (const child of n.children || []) parentOf.set(child, id);
  const conditional = (id: string): boolean => { for (let at = parentOf.get(id); at; at = parentOf.get(at)) if (CONDITIONAL.has(nodes[at].type)) return true; return false; };
  const firstLevel = Object.entries(nodes).filter(([id, n]) => n.type === Nt.Title && (n.props.level || 'h1') === 'h1' && !conditional(id)).map(([, n]) => n);
  for (const n of firstLevel.slice(1))
    out.push(diag('heading-many-h1', `this page has ${firstLevel.length} \`Title\`s at h1; one says what the page is, the rest are sections: \`Title "…" h2\`.`, { loc: n.loc, severity: 'warning' }));
  return out;
}
