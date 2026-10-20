// validate-schema: what a page or store declares about its data, checked on its own: every state has a real type (a
// scalar, an entity, a list of one) and a matching initial value, a query is a list and is not persisted, entity fields
// have types a Form can render, and each constraint fits its field (`pattern` on text, `min` on a number…).
import { diag, closest } from '#engine/shared/diagnostics.js';
import { themeValue, themeHeads } from '#engine/style/theme-ref.js';
import type { Diagnostic, Doc, Entity, Loc, ThemeRaw } from '#engine/shared/types.js';

/** The scalar types a state or a list element may have. */
export const SCALARS = ['text', 'number', 'bool', 'uuid', 'email', 'string', 'date', 'password', 'textarea', 'file'];
const FIELD_TYPES = ['text', 'string', 'email', 'number', 'bool', 'date', 'password', 'textarea', 'uuid']; // the entity-field types a Form renders

/** The schema diagnostics of a page or store. */
export function schemaDiagnostics(doc: Doc): Diagnostic[] {
  const D: Diagnostic[] = [];
  // state types: a `list` must declare its element type (always know what's inside)
  const entityNames = Object.keys(doc.entities || {});
  for (const [name, def] of Object.entries(doc.state || {})) {
    const t = def.type;
    // a type is a scalar, an entity, or a list of one: `numbr`, `txt`, `lst<number>` used to pass and do nothing typed
    // (a query of a function with no type holds what its package gives back: a Stripe object, a snapshot, as it is)
    if (!(def.call && !t) && t !== 'list' && !t.startsWith('list<') && !SCALARS.includes(t) && !entityNames.includes(t))
      D.push(diag('unknown-type', `state "${name}": "${t}" is not a type. Use a scalar (${SCALARS.slice(0, 5).join(', ')}…), an entity (${entityNames.join(', ') || 'none declared'}) or \`list<…>\``, { loc: def.loc, suggestion: closest(t, [...SCALARS, ...entityNames, ...SCALARS.map((s) => `list<${s}>`)]), from: t }));
    if (def.persist && def.source) D.push(diag('persist-query', `"${name}" is a query: the server is where it comes from, so \`persist\` would keep a second, stale copy in localStorage. Drop \`persist\`: coming back to a page already shows the last list at once and refreshes it.`, { loc: def.loc ?? null }));
    if (def.source?.startsWith('query:') && !def.call && t !== 'list' && !t.startsWith('list<')) {   // a function query may give back one thing
      // a query's data is always an array: a single-record type silently renders empty (no fetch-one).
      D.push(diag('query-not-list', `state "${name}" is a query but typed "${t}" — a query returns a LIST (the data is an array). Use \`list<${t}>\` and read it with \`each\`. (Single-record fetch isn't supported in muten.)`, { loc: def.loc, suggestion: `list<${t}>` }));
    }
    if (def.refresh != null && def.live) D.push(diag('polling-live', `state "${name}" is \`live\` (it arrives by itself) and also asks again \`every …\`: keep one.`, { loc: def.loc }));
    if (t === 'list') {
      D.push(diag('untyped-list', `state "${name}" is an untyped "list" — declare the element type, e.g. list<uuid> or list<User>`, { loc: def.loc, suggestion: 'list<uuid>' }));
    } else if (t.startsWith('list<')) {
      const elem = t.slice(5, -1);
      if (!SCALARS.includes(elem) && !entityNames.includes(elem)) {
        D.push(diag('unknown-type', `list element "${elem}" is not a known entity or scalar type`, { loc: def.loc, suggestion: closest(elem, [...entityNames, ...SCALARS]), from: elem }));
      }
      // a list's initial must BE a list. `items = {} : list<X>` (the draft-seed slip) lints clean today and then
      // crashes at runtime ("{} is not iterable"). Catch it: a given initial must be an array.
      if (def.initial != null && !Array.isArray(def.initial)) {
        D.push(diag('type-mismatch', `state "${name}" is a list, but its initial value is not a list — use \`[]\` (or a list of ${elem})`, { loc: def.loc, suggestion: '[]' }));
      }
    } else if (def.initial !== undefined && def.initial !== null) {
      // a scalar state's initial value must match its declared type (e.g. `count = "" : number` is a bug)
      const want = t === 'number' ? 'number' : t === 'bool' ? 'boolean' : (['text', 'string', 'email', 'uuid', 'date'].includes(t) ? 'string' : '');
      if (want && typeof def.initial !== want) {
        D.push(diag('type-mismatch', `state "${name}" is typed "${t}" but its initial value is a ${typeof def.initial}`, { loc: def.loc }));
      }
    }
  }

  // entity field TYPES: an unknown type (a typo like `numbr`, an unsupported input like `url`/`tel`/`file`, or a
  // nested entity) silently renders as a plain TEXT input — the author's intent is lost with no error. Flag it so
  // the oracle catches the slip. (`text`→stored as `string`; `id uuid` is implicit; enums are `enum:a|b`.)
  const FIELD_DISPLAY = ['text', 'email', 'number', 'bool', 'date', 'password', 'textarea'];
  for (const [ent, fields] of Object.entries(doc.entities || {})) {
    for (const [field, ftype] of Object.entries(fields)) {
      if (ftype.startsWith('enum:') || FIELD_TYPES.includes(ftype)) continue;
      if (/^list<(string|number|bool|uuid|email)>$/.test(ftype)) continue; // a field holding a list of scalars (features, tags) — iterate it with `each item.<field>`
      D.push(diag('unknown-field-type', `entity "${ent}" field "${field}": "${ftype}" isn't a field type — it silently renders as a plain text input. Use one of ${FIELD_DISPLAY.join(' / ')}, an \`a | b\` enum, or a Custom for anything else.`, { from: ftype, suggestion: closest(ftype, FIELD_DISPLAY) }));
    }
  }

  // constraints apply to specific field kinds: a `pattern` on a number, or `min` on a bool, is a guard that
  // silently does nothing — the author thinks they added validation. Reject the mismatch with the reason.
  for (const [ent, fields] of Object.entries(doc.constraints || {})) {
    const edef: Entity = doc.entities?.[ent] || {};
    for (const [field, c] of Object.entries(fields)) {
      const ft = edef[field] || '', stringy = ft === 'string' || ft === 'email' || ft === 'password' || ft === 'textarea', kind = ft.startsWith('enum:') ? 'enum' : ft === 'string' ? 'text' : ft;
      if (c.pattern != null && !stringy) D.push(diag('constraint-kind', `\`pattern\` on "${ent}.${field}" (a ${kind}) does nothing — \`pattern\` validates text/email fields only.`, { from: field }));
      if ((c.min != null || c.max != null) && ft !== 'number' && !stringy) D.push(diag('constraint-kind', `\`min\`/\`max\` on "${ent}.${field}" (a ${kind}) does nothing — they bound a number's value or text's length only.`, { from: field }));
      if (c.required && ft.startsWith('enum:')) D.push(diag('constraint-kind', `\`required\` on "${ent}.${field}" is redundant — an enum always has a value.`, { from: field }));
    }
  }
  return D;
}

/** `theme.colors.primary`: a value theme.muten has, with the closest one when it does not (style/theme-ref.ts). */
export function themeRefDiagnostics(theme: ThemeRaw, path: string[], loc: Loc | null): Diagnostic[] {
  if (themeValue(theme, path) !== undefined) return [];
  const section = theme[path[0]];
  const near = section && path[1] !== undefined ? closest(path[1], Object.keys(section)) : closest(path[0], themeHeads(theme));
  return [diag('theme-ref', `theme.muten has no \`${path.join('.')}\`${section ? ` (${path[0]} has: ${Object.keys(section).join(', ')})` : ''}`, { loc, suggestion: near, from: path.join('.') })];
}
