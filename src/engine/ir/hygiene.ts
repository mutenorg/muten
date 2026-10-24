// hygiene: what a page carries that does nothing, or that not everyone gets. Warnings, never errors. (An Image with no
// alt is already an error: alt is a required prop, missing-prop.)
//   · unused-state         a page state nothing reads, binds or changes
//   · unused-action        a page action nothing calls
//   · text-not-translated  words written in the page while the app speaks through src/lang (they stay in one language)
//   · use-react-redundant  `use react X` where `use X` says the same (muten tells a component by how it is used)
// A store's members are read from other pages, so a store is not asked about what it does not use itself.
import { diag } from '#engine/shared/diagnostics.js';
import { Nt, Ek, UseKind } from '#engine/shared/vocab.js';
import type { Diagnostic, Doc, FlatNode, StringPropValue } from '#engine/shared/types.js';

/** Nodes whose own text is on screen. */
const SAYS: ReadonlySet<string> = new Set([Nt.Text, Nt.Span, Nt.Title, Nt.Button, Nt.Link]);
// words to translate are a phrase: a single word is usually a name that stays (WhatsApp, Instagram, US$, Cookies)
const WORDS = /\p{L}{2,}\s+\p{L}{2,}/u;   // a phrase has spaces: storio.ink/bruma is an address, not words

/** Whether `name` is written anywhere in `text` as a whole name (not inside another). */
const mentions = (text: string, name: string): boolean => new RegExp(`(^|[^\\w$])${name.replace(/[$]/g, '\\$')}([^\\w]|$)`).test(text);

/** A text prop with words of its own (not only values, not a t("key")). */
function handWritten(value: StringPropValue | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return WORDS.test(value);
  if ('$param' in value) return false;
  return value.parts.some((part) => typeof part === 'string' && WORDS.test(part)) && !value.parts.some((part) => typeof part !== 'string' && part.kind === Ek.Call && part.fn === 't');
}

/** The hygiene warnings of a page (`speaks`: the app has src/lang files). */
export function hygieneDiagnostics(doc: Doc, nodes: { [id: string]: FlatNode }, isStore: boolean, speaks: boolean): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of Object.values(nodes)) {
    if (speaks && SAYS.has(n.type) && handWritten(n.props.value))
      out.push(diag('text-not-translated', `this ${n.type}'s words are written in the page, while the app speaks through src/lang: they stay in one language. Move them to a .lang file and write \`t("key")\`.`, { loc: n.loc, severity: 'warning' }));
  }
  for (const def of doc.imports || []) if (def.kind === UseKind.React)
    out.push(diag('use-react-redundant', `\`use react ${def.names.join(', ')}\` can be \`use ${def.names.join(', ')}\`: written where an element goes, muten knows it is a React component.`, { loc: def.loc ?? null, severity: 'warning', word: 'react' }));
  if (isStore) return out;
  // everything that can mention a state or an action, as text: the nodes, the actions, gets, effects, beats, settles
  const said = JSON.stringify([nodes, doc.actions, doc.gets, doc.fns, doc.effects, doc.timers, doc.settles]);
  for (const [name, def] of Object.entries(doc.state || {}))
    if (!mentions(said, name)) out.push(diag('unused-state', `state "${name}" is never read, bound or changed: remove it, or use it.`, { loc: def.loc ?? null, severity: 'warning', from: name }));
  const others = (name: string): string => JSON.stringify([nodes, Object.entries(doc.actions || {}).filter(([other]) => other !== name), doc.effects, doc.timers, doc.settles]);
  for (const name of Object.keys(doc.actions || {}))
    if (!mentions(others(name), name)) out.push(diag('unused-action', `action "${name}" is never called: remove it, or wire it to an event.`, { loc: doc.actions[name].body?.[0]?.loc ?? null, severity: 'warning', from: name }));
  return out;
}
