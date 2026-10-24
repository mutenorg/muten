// part-params: a part is called with its parameters, and reads only those. Inlining resolves `$name` against the call's
// arguments, and both sides used to fail without a word: an argument the part does not declare was dropped
// (`Topbar(puased: no)`: the bar stayed unpaused), and a `$name` that is no parameter fell through as a bare `name`, so
// every PAGE that called the part was told «`name` is not declared», with a near name from that page. Compose marks the
// node (`strays`), flatten keeps the mark, and validate says it at the node's place: a stray `$name` in the part's file,
// a stray argument at the call. Nothing stops there, so every call and every line is said, not only the first.

import { Ek } from '#engine/shared/vocab.js';
import { closest, diag } from '#engine/shared/diagnostics.js';
import type { Diagnostic, FlatNode, IRNode, NodeProps, PartDef } from '#engine/shared/types.js';
import type { Stray } from '#engine/shared/types-stray.js';

export const UNKNOWN_PARAM = 'unknown-param';
export const UNKNOWN_ARG = 'unknown-arg';
const UNKNOWN_REF = 'unknown-ref';

/** The props that hold a name as plain text (`-> $onPick`, `bind($value)`), not as an expression. */
const NAME_PROPS: ReadonlySet<string> = new Set<keyof NodeProps>(['action', 'submit', 'bind']);

/** The parameter a `$name` / `$name.field` reads. */
const headOf = (name: string): string => name.slice(1).split('.')[0];

/** Every `$` name in one value of a node (a prop, an argument), wherever it sits: a `{ $param }` slot, an expression, a list. */
function heads(value: unknown, key: string, out: string[]): void {
  if (typeof value === 'string') { if (NAME_PROPS.has(key) && value.startsWith('$')) out.push(headOf(value)); return; }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) heads(item, key, out); return; }
  const fields = Object.entries(value);
  for (const [field, inner] of fields) {
    if (field === '$param' && typeof inner === 'string') out.push(inner);
    else if (typeof inner === 'string' && inner.startsWith('$') && (field === 'name' || field === 'list') && fields.some(([k, kind]) => k === 'kind' && (kind === Ek.Ref || kind === Ek.Agg || kind === Ek.Filter))) out.push(headOf(inner));
    else heads(inner, field, out);
  }
}

const names = (part: PartDef): string[] => part.params.map((param) => param.name);

/** The `$name`s one node of part `name` reads that are not its parameters (the node as written, before inlining). */
export function strayParams(name: string, part: PartDef, node: IRNode): Stray[] {
  const params = names(part);
  const found: string[] = [];
  heads(node.props, '', found);
  heads(node.args, '', found);
  return [...new Set(found)].filter((head) => !params.includes(head))
    .map((head) => ({ code: UNKNOWN_PARAM, word: '$' + head, near: (near => near && '$' + near)(closest(head, params)), part: name, params: params.map((param) => '$' + param) }));
}

/** The arguments a call passes to part `name` that are not its parameters. */
export function strayArgs(name: string, part: PartDef, call: IRNode): Stray[] {
  const params = names(part);
  const passed = Object.keys(call.args || {});
  return passed.filter((key) => !params.includes(key))
    .map((key) => ({ code: UNKNOWN_ARG, word: key, near: closest(key, params.filter((param) => !passed.includes(param))), part: name, params }));
}

/** What validate says for every marked node, at the node's place. */
export function strayDiagnostics(nodes: { [id: string]: FlatNode }): Diagnostic[] {
  return Object.values(nodes).flatMap((node) => (node.strays || []).map((stray) => {
    const list = stray.params.length ? stray.params.map((param) => '`' + param + '`').join(', ') : 'none';
    const message = stray.code === UNKNOWN_PARAM
      ? `\`${stray.word}\` is not a parameter of ${stray.part}: its parameters are ${list}. Declare it in \`part ${stray.part}(…)\` or read one of those.`
      : `\`${stray.word}\` is not a parameter of ${stray.part}, so the part never gets it: its parameters are ${list}.`;
    // a stray argument is dropped, and the app has run that way: a warning, so upgrading muten never fails a build that
    // worked (Storio's signup passed `beating` to a StoreSkeleton that takes nothing). A stray `$name` reads nothing: an error.
    return diag(stray.code, message, { loc: node.loc ?? null, suggestion: stray.near, from: stray.word, severity: stray.code === UNKNOWN_ARG ? 'warning' : 'error' });
  }));
}

/** The findings without the echoes of a stray `$name`: inlined, it is left as a bare `name`, and every page that calls
 *  the part would also be told «`name` is not declared». The part's finding already says it, at the right line. */
export function withoutEchoes(found: Diagnostic[], nodes: { [id: string]: FlatNode }): Diagnostic[] {
  const strayed = new Set(Object.values(nodes).flatMap((node) => (node.strays || []).filter((stray) => stray.code === UNKNOWN_PARAM).map((stray) => stray.word.slice(1))));
  return strayed.size ? found.filter((d) => !(d.code === UNKNOWN_REF && d.word && strayed.has(d.word))) : found;
}
