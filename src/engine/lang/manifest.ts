// manifest — the SINGLE source of the language's vocabulary AND its documentation.
//
// Consulted by: parse (positional string-props + which primitives interpolate), validate (required
// props, known types/ops), and the VS Code extension's autocomplete + hovers. Each primitive carries
// a one-line `doc` + a completion `snippet`, so the surface and its help never drift apart. Adding or
// changing the language starts HERE (and its codegen in compile/), then re-run the highlight generator.

import { SUGGESTED, resolveToken } from '#engine/style/tokens.js';
import type { Primitive } from '#engine/shared/types.js';

export const PRIMITIVES: { [name: string]: Primitive } = {
  Stack: {
    props: { style: 'tokens?' }, children: true,
    doc: 'Vertical stack (flex column) — its identity. For a horizontal layout, use a region with style(row). Card look: class(card).',
    snippet: 'Stack {\n\t$0\n}',
  },
  Header: {
    props: { style: 'tokens?' }, children: true,
    doc: 'Page header landmark (<header>). Lay it out with style(row, between, center, …).',
    snippet: 'Header style(row, between, center) {\n\t$0\n}',
  },
  Nav: {
    string: 'label', props: { label: 'text?', style: 'tokens?' }, children: true,
    doc: 'Navigation landmark (<nav>). Optional label → aria-label (disambiguates multiple navs). `Nav "Primary" style(row, gap.md) { … }`.',
    snippet: 'Nav style(row, gap.md) {\n\t$0\n}',
  },
  Sidebar: {
    props: { style: 'tokens?' }, children: true,
    doc: 'Complementary landmark (<aside>). Position with style(left) or style(right).',
    snippet: 'Sidebar style(left) {\n\t$0\n}',
  },
  Footer: {
    props: { style: 'tokens?' }, children: true,
    doc: 'Footer landmark (<footer>).',
    snippet: 'Footer style(padding.md) {\n\t$0\n}',
  },
  Page: {
    props: { style: 'tokens?' }, children: true,
    doc: 'The page content root (<main>) — one per route, mounts into the shell’s `slot`. No imposed look; lay it out with style().',
    snippet: 'Page {\n\t$0\n}',
  },
  Text: {
    string: 'value', props: { value: 'text', style: 'tokens?' }, children: false, interp: true,
    doc: 'Paragraph text (<p>). Interpolates state reactively: `Text "Hi, {user.name}"`.',
    snippet: 'Text "$1"',
  },
  Title: {
    string: 'value', props: { value: 'text', style: 'tokens?' }, children: false, interp: true,
    doc: 'Heading. Level via keyword: `Title "Hi" h2` → <h2> (h1…h6; default h1). Prefer one h1 per page. Interpolates state.',
    snippet: 'Title "$1"',
  },
  Span: {
    string: 'value', props: { value: 'text', style: 'tokens?' }, children: false, interp: true,
    doc: 'Inline text (<span>). Interpolates state: `Span "{cart.total}"`.',
    snippet: 'Span "$1"',
  },
  Image: {
    string: 'src', props: { src: 'text', alt: 'text', style: 'tokens?' }, children: false, interp: true,
    doc: 'Image (<img>). `alt` is required (a11y/SEO): `Image "{p.image}" alt "{p.title}"`. Use alt "" for decorative images.',
    snippet: 'Image "{${1:item.image}}" alt "${2:description}"',
  },
  SearchField: {
    string: 'placeholder', props: { bind: 'state', placeholder: 'text?' }, children: false,
    doc: 'Search input two-way bound to a text state.',
    snippet: 'SearchField bind @${1:search} "${2:Search by name}"',
  },
  DataTable: {
    props: { data: 'state', where: 'clauses?', columns: 'fields', style: 'tokens?' }, children: true,
    doc: 'Reactive table over a list/query. Static `where` filters are pushed to the query; dynamic ones stay reactive.',
    snippet: 'DataTable @${1:items}\n\tcolumns(${2:name})',
  },
  RowAction: {
    string: 'label', props: { label: 'text', action: 'action', arg: 'expr?' }, children: false,
    doc: 'A button rendered in each DataTable row: `RowAction "Delete" -> deleteItem(row.id)`.',
    snippet: 'RowAction "${1:Delete}" -> ${2:action}(row.id)',
  },
  Button: {
    string: 'label', props: { label: 'text?', action: 'action?', arg: 'expr?', style: 'tokens?' }, children: true, interp: true,
    doc: 'Clickable button → runs an action. Label interpolates (`Button "{x}"`) OR use `{ }` children for a clickable card. `-> action(arg)`; arg may be a ref or a literal.',
    snippet: 'Button "${1:label}" -> ${2:action}($3)',
  },
  Form: {
    string: 'submitLabel', props: { bind: 'state', submit: 'action', submitLabel: 'text?' }, children: false,
    doc: 'Auto-form: one field per entity field, two-way bound to a draft state.',
    snippet: 'Form bind @${1:draft} submit ${2:createItem} "${3:Save}"',
  },
  Link: {
    string: 'label', props: { label: 'text?', to: 'route', style: 'tokens?' }, children: true, interp: true,
    doc: 'Navigation link: `Link "Catalog" -> /catalog`. Label interpolates, OR use `{ }` children for a clickable card that navigates. Client-side (no full reload).',
    snippet: 'Link "${1:label}" -> /${2:route}',
  },
  slot: {
    props: {}, children: false,
    doc: 'The outlet in a `shell { }` where the active route’s page mounts.',
    snippet: 'slot',
  },
  When: {
    props: { cond: 'expr' }, children: true, control: true,
    doc: 'Conditional render: `when <expr> { ... }`. Mounts/unmounts reactively.',
    snippet: 'when ${1:cond} {\n\t$0\n}',
  },
  Each: {
    props: { list: 'expr', as: 'ident' }, children: true, control: true,
    doc: 'List render: `each <list> as <item> { ... }`. The item is a scope variable in the template.',
    snippet: 'each ${1:items} as ${2:item} {\n\t$0\n}',
  },
  Custom: {
    props: { component: 'name', inputs: 'map?', on: 'map?' }, children: false,
    doc: 'Escape hatch (§7): mount a host component from `src/components/<Name>.js`. Opaque to the IR; connected via inputs/on.',
    snippet: 'Custom ${1:Name} inputs(${2:prop}: ${3}) on(${4:event}: ${5:action})',
  },
};

export const MODIFIERS = ['bind', 'submit', 'where', 'columns', 'style', 'class', 'alt', 'inputs', 'on'];
export const MODIFIER_DOCS = {
  bind: 'Two-way bind to a @state, e.g. `bind @search`.',
  submit: 'Action to run on form submit, e.g. `submit createUser`.',
  where: 'Filter clauses: `where(role == admin, name contains @q)`.',
  columns: 'Columns to show: `columns(name, email, role)`.',
  style: 'Layout & typography tokens (Muten builds, doesn’t skin): `style(row, gap.md, text.lg)`.',
  class: 'Raw CSS class(es) for LOOK — your CSS or a third-party like Tailwind: `class(card)` or `class("flex gap-4")`. Muten stays agnostic about appearance.',
  alt: 'Required accessible/SEO text for an Image: `alt "{p.title}"`. Use "" for decorative images.',
  inputs: 'Custom component inputs: `inputs(data: @sales)`.',
  on: 'Custom component events wired to actions: `on(select: pick)`.',
};

export const KEYWORDS = ['screen', 'entity', 'state', 'store', 'const', 'theme', 'get', 'effect', 'action', 'mutates', 'mock', 'sources', 'routes', 'shell', 'guard', 'else', 'part', 'query', 'if', 'when', 'each', 'as', 'and', 'or', 'not', 'contains'];
export const KEYWORD_DOCS = {
  screen: 'Declares the screen name: `screen users_dashboard`.',
  entity: 'Declares a data shape + validation: `entity User { name text required  email email required  password text min:8 }` (implicit uuid id). Constraints: `required`, `min:N`, `max:N`.',
  state: 'Declares reactive state: `state { search = "" : text  users = query listUsers : list<User> }`.',
  store: 'App-GLOBAL reactive state (shared across pages, no prop drilling): `store { cart = [] : list<number> }`. Referenced by name like local state.',
  const: 'A compile-time IMMUTABLE scalar, inlined (never reactive): `const TAX = 0.21`. Scalars only — structured config uses a block (e.g. theme).',
  theme: 'The project theme block (theme.muten): `theme { space { md "16px" }  breakpoints { md "768px" } }`. Supplies the token SCALE; the engine owns only the vocabulary. The reset/base CSS lives in your stylesheet.',
  get: 'A `.store` derived/memoized value (getter): `get total = items.length`. Read as `domain.total`, recomputes when deps change.',
  effect: 'A `.store` reactive side-effect (Angular-style): `effect { ... }`. Re-runs automatically when the store state it reads changes.',
  action: 'Declares a mutation: `action delete mutates users <- id { users.remove(u => u.id == id) }`.',
  mutates: 'Lists the state an action may mutate — the linter enforces it.',
  mock: 'Inline mock data for queries: `mock { listUsers: [ { name: "Ana", role: admin } ] }`.',
  sources: 'Real data sources for queries: `sources { listChars: { url: "https://api...", at: "results" } }`.',
  routes: 'App root (app.muten): maps URLs to pages, `routes { /url -> page }`. The single source of truth the AI reads.',
  shell: 'Persistent app chrome in app.muten: `shell { Header { … }  slot  Footer { … } }`. Wraps every route; `slot` is where the active Page (<main>) mounts.',
  guard: 'Route guard in app.muten: `routes { /cart -> cart guard auth.loggedIn else /login }`. If the store boolean is false on navigation, redirect. Guest-only page: `guard not auth.loggedIn else /catalog`.',
  else: 'The redirect target of a route `guard`: `guard auth.loggedIn else /login`.',
  part: 'Reusable composition: `part Card(item: Item, onPick: action) { ... }`. Pass OBJECTS (`$item.field`) and ACTION callbacks (`-> $onPick(...)`). Inlined at build time.',
  query: 'An async data source. The state exposes `.loading`, `.error` and `.data`.',
  if: 'Conditional INSIDE an action body: `if <expr> { … } else { … }` — the only branching in actions (toggles, validation, add-or-remove).',
  when: 'Conditional render: `when <expr> { ... }`.',
  each: 'List render: `each <list> as <item> { ... }`.',
  as: 'Names the item variable in an `each`.',
  and: 'Logical AND.',
  or: 'Logical OR.',
  not: 'Logical NOT, e.g. `when not (cart.isEmpty)`.',
  contains: 'Case-insensitive substring match: `name contains @q`.',
};

export const ACTION_OPS = ['push', 'remove', 'reset', 'set'];
export const ACTION_OP_DOCS = {
  push: 'Append to a list state: `users.push(draft)` (auto-fills uuid fields).',
  remove: 'Remove matching items: `users.remove(u => u.id == id)`.',
  reset: 'Reset a state to its declared initial: `draft.reset()`.',
  set: 'Set a state value: `rating.set(v)`.',
};

export const PRIMITIVE_NAMES = Object.keys(PRIMITIVES);
export const TOKEN_NAMES = SUGGESTED; // curated suggestions; validation accepts the full OPEN set
export { resolveToken };
