// manifest: single source of the language vocabulary and its documentation.
// Consulted by parse (positional string-props, interpolating primitives), validate (required
// props, known types/ops), and the VS Code extension (autocomplete + hovers). Each primitive
// carries a `doc` and a `snippet` so the surface and its help never drift apart.
// Language changes start here (and in compile/), then re-run the highlight generator.

import type { Primitive } from '#engine/shared/types.js';

export const PRIMITIVES: { [name: string]: Primitive } = {
  Stack: {
    props: {}, children: true,
    doc: 'Vertical stack (flex column) — its identity. For a horizontal layout, use class("flex flex-row"). Card look: class(card).',
    snippet: 'Stack {\n\t$0\n}',
  },
  Header: {
    props: {}, children: true,
    doc: 'Page header landmark (<header>). Lay it out with class("flex flex-row items-center justify-between …").',
    snippet: 'Header class("flex flex-row items-center justify-between") {\n\t$0\n}',
  },
  Nav: {
    string: 'label', props: { label: 'text?' }, children: true,
    doc: 'Navigation landmark (<nav>). Optional label → aria-label (disambiguates multiple navs). `Nav "Primary" class("flex flex-row gap-4") { … }`.',
    snippet: 'Nav class("flex flex-row gap-4") {\n\t$0\n}',
  },
  Sidebar: {
    props: {}, children: true,
    doc: 'Complementary landmark (<aside>). Position/size with class().',
    snippet: 'Sidebar {\n\t$0\n}',
  },
  Footer: {
    props: {}, children: true,
    doc: 'Footer landmark (<footer>).',
    snippet: 'Footer {\n\t$0\n}',
  },
  Page: {
    props: {}, children: true,
    doc: 'The page content root (<main>) — one per route, mounts into the shell’s `slot`. No imposed look; lay it out with class().',
    snippet: 'Page {\n\t$0\n}',
  },
  Text: {
    string: 'value', props: { value: 'text' }, children: false, interp: true,
    doc: 'Paragraph text (<p>). Interpolates state reactively: `Text "Hi, {user.name}"`.',
    snippet: 'Text "$1"',
  },
  Title: {
    string: 'value', props: { value: 'text' }, children: false, interp: true,
    doc: 'Heading. Level via keyword: `Title "Hi" h2` → <h2> (h1…h6; default h1). Prefer one h1 per page. Interpolates state.',
    snippet: 'Title "$1"',
  },
  Span: {
    string: 'value', props: { value: 'text' }, children: false, interp: true,
    doc: 'Inline text (<span>). Interpolates state: `Span "{cart.total}"`.',
    snippet: 'Span "$1"',
  },
  Image: {
    string: 'src', props: { src: 'text', alt: 'text' }, children: false, interp: true,
    doc: 'Image (<img>). `alt` is required (a11y/SEO): `Image "{p.image}" alt "{p.title}"`. Use alt "" for decorative images.',
    snippet: 'Image "{${1:item.image}}" alt "${2:description}"',
  },
  Icon: {
    string: 'name', props: { name: 'text' }, children: false,
    doc: 'Icon from ANY library via Iconify `set:name`: `Icon "lucide:settings"`, `Icon "tabler:home"`. Inlined as SVG at build (only the icons you use ship — tree-shaken, no runtime). Color + size via class() (uses currentColor + 1em). The set must be installed: `npm i -D @iconify-json/<set>` (scaffold pre-installs lucide). Name is a STATIC literal (resolved at build).',
    snippet: 'Icon "${1:lucide:settings}"',
  },
  Video: {
    string: 'src', props: { src: 'text' }, children: false, interp: true,
    doc: 'Video (<video>). Boolean controls are bare keywords: `controls autoplay loop muted playsinline`. `Video "clip.mp4" controls` · `Video "~/media/intro.mp4" autoplay loop muted`. Size via class().',
    snippet: 'Video "${1:clip.mp4}" controls',
  },
  SearchField: {
    string: 'placeholder', props: { bind: 'state', placeholder: 'text?' }, children: false, interp: true,
    doc: 'Search input two-way bound to a text state. The placeholder interpolates: `SearchField bind @draft "Message #{channel}"`.',
    snippet: 'SearchField bind(${1:search}) "${2:Search by name}"',
  },
  DataTable: {
    props: { data: 'state', where: 'clauses?', columns: 'fields' }, children: true,
    doc: 'Reactive table over a list/query. Static `where` filters are pushed to the query; dynamic ones stay reactive.',
    snippet: 'DataTable @${1:items}\n\tcolumns(${2:name})',
  },
  RowAction: {
    string: 'label', props: { label: 'text', action: 'action', arg: 'expr?' }, children: false,
    doc: 'A button rendered in each DataTable row: `RowAction "Delete" -> deleteItem(row.id)`.',
    snippet: 'RowAction "${1:Delete}" -> ${2:action}(row.id)',
  },
  Button: {
    string: 'label', props: { label: 'text?', action: 'action?', arg: 'expr?' }, children: true, interp: true,
    doc: 'Clickable button → runs an action. Label interpolates (`Button "{x}"`) OR use `{ }` children for a clickable card. `-> action(arg)`; arg may be a ref or a literal.',
    snippet: 'Button "${1:label}" -> ${2:action}($3)',
  },
  Form: {
    string: 'submitLabel', props: { bind: 'state', submit: 'action', submitLabel: 'text?' }, children: false,
    doc: 'Auto-form: one field per entity field, two-way bound to a draft state.',
    snippet: 'Form bind(${1:draft}) submit(${2:createItem}) "${3:Save}"',
  },
  Link: {
    string: 'label', props: { label: 'text?', to: 'route' }, children: true, interp: true,
    doc: 'Navigation link: `Link "Catalog" -> "/catalog"`. Label interpolates, OR use `{ }` children for a clickable card that navigates. Client-side (no full reload).',
    snippet: 'Link "${1:label}" -> "/${2:route}"',
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
    props: { list: 'expr', as: 'ident', filter: 'expr?' }, children: true, control: true,
    doc: 'List render: `each <list> as <item> { ... }`. Filter with `where`: `each posts as p where p.published { ... }` renders only matching items (no leak). The item is a scope variable in the template.',
    snippet: 'each ${1:items} as ${2:item} {\n\t$0\n}',
  },
  Custom: {
    props: { component: 'name', inputs: 'map?', on: 'map?' }, children: false,
    doc: 'Escape hatch (§7): mount a host component from `src/components/<Name>.js`. Opaque to the IR; connected via inputs/on.',
    snippet: 'Custom ${1:Name} inputs(${2:prop}: ${3}) on(${4:event}: ${5:action})',
  },
};

export const MODIFIERS = ['bind', 'submit', 'where', 'columns', 'class', 'alt', 'inputs', 'on', 'aria'];
export const MODIFIER_DOCS = {
  bind: 'Two-way bind to a @state, e.g. `bind @search`.',
  submit: 'Action to run on form submit, e.g. `submit createUser`.',
  where: 'Filter clauses: `where(role == admin, name contains @q)`.',
  columns: 'Columns to show: `columns(name, email, role)`.',
  class: 'The ONE way to style: raw CSS class(es) — Tailwind utilities (`class("flex flex-row gap-4")`) or your own CSS (`class("card")`, backed by styles.css using theme.muten CSS vars). Muten stays agnostic about appearance.',
  alt: 'Required accessible/SEO text for an Image: `alt "{p.title}"`. Use "" for decorative images.',
  inputs: 'Custom component inputs: `inputs(data: @sales)`.',
  on: 'Custom component events wired to actions: `on(select: pick)`.',
  aria: 'Accessibility attributes on ANY node — the bounded way to write `aria-*`/`role` (muten is HTML + logic): `aria(label: "Close", role: "dialog", expanded: menuOpen)`. Each key → `aria-<key>`; `role` → `role`. A literal value is a static attribute; a value that reads state is REACTIVE (e.g. `aria(expanded: open)` keeps aria-expanded in sync). Use this for an accessible interactive widget instead of escaping to Custom.',
};

export const KEYWORDS = ['screen', 'entity', 'state', 'store', 'const', 'theme', 'get', 'effect', 'action', 'mutates', 'mock', 'sources', 'api', 'meta', 'routes', 'shell', 'guard', 'else', 'part', 'param', 'query', 'every', 'live', 'persist', 'post', 'put', 'delete', 'body', 'if', 'when', 'each', 'as', 'where', 'by', 'with', 'and', 'or', 'not', 'contains', 'use', 'from'];
export const KEYWORD_DOCS = {
  screen: 'Declares the screen name: `screen users_dashboard`.',
  entity: 'Declares a data shape + validation: `entity User { name text required  email email required  zip text pattern:"^\\d{5}$" }` (implicit uuid id). Constraints: `required`, `min:N`, `max:N`, `pattern:"<regex>"`. An `email` field validates its format on submit; `pattern` matches a value against your regex.',
  state: 'Declares reactive state: `state { search = "" : text  users = query listUsers : list<User> }`.',
  store: 'App-GLOBAL reactive state (shared across pages, no prop drilling): `store { cart = [] : list<number> }`. Referenced by name like local state.',
  const: 'A compile-time IMMUTABLE scalar, inlined (never reactive): `const TAX = 0.21`. Scalars only — structured config uses a block (e.g. theme).',
  theme: 'The project theme block (theme.muten): `theme { space { md "16px" }  breakpoints { md "768px" } }`. Supplies the token SCALE; the engine owns only the vocabulary. The reset/base CSS lives in your stylesheet.',
  get: 'A `.store` derived/memoized value (getter): `get total = items.length`. Read as `domain.total`, recomputes when deps change.',
  effect: 'A `.store` reactive side-effect (Angular-style): `effect { ... }`. Re-runs automatically when the store state it reads changes.',
  action: 'Declares a mutation: `action delete(uid: text) mutates users { users.remove where id == uid }`.',
  mutates: 'Lists the state an action may mutate — the linter enforces it.',
  mock: 'Inline mock data for queries: `mock { listUsers: [ { name: "Ana", role: admin } ] }`.',
  sources: 'Real data sources for queries: `sources { listChars: { url: "https://api...", at: "results" } }`.',
  api: 'App-wide backend config in app.muten: `api { base: "https://…" headers: { … } }`. A relative `sources` url is joined to `base`; headers merge (the source wins).',
  meta: 'Page <head> metadata: `meta { title "…" description "…" }` → `<title>` + `<meta>` tags (og:* auto-derived). Applied on navigation.',
  post: 'Explicit non-REST request in an action: `post "shop:/orders" body item` (escape hatch when CRUD ops do not fit).',
  put: 'Explicit non-REST request in an action: `put "shop:/orders/{id}" body item`.',
  body: 'The JSON body of an explicit `post`/`put` request: `post "shop:/x" body item`.',
  routes: 'App root (app.muten): maps URLs to pages, `routes { /url -> page }`. The single source of truth the AI reads.',
  shell: 'Persistent app chrome in app.muten: `shell { Header { … }  slot  Footer { … } }`. Wraps every route; `slot` is where the active Page (<main>) mounts.',
  guard: 'Route guard in app.muten: `routes { /cart -> cart guard auth.loggedIn else /login }`. If the store boolean is false on navigation, redirect. Guest-only page: `guard not auth.loggedIn else /catalog`.',
  else: 'The redirect target of a route `guard`: `guard auth.loggedIn else /login`.',
  part: 'Reusable composition: `part Card(item: Item, onPick: action) { ... }`. Pass OBJECTS (`$item.field`) and ACTION callbacks (`-> $onPick(...)`). Inlined at build time.',
  param: 'Declares a route param read from the URL: `param id` for a route `/x/:id`. Usable in interpolation/`when`/expressions like a read-only string.',
  query: 'An async data source. The state exposes `.loading`, `.error` and `.data`.',
  persist: 'Backs a state with localStorage: `state { theme = "dark" : text persist }` (or `favs = [] : list<number> persist`). Hydrates on load (falls back to the declared initial) and saves on every change — survives reload. THE declarative localStorage — never hand-roll load/save in a `use` fn. Works page-local AND in a `.store` for app-global persisted state (favorites/cart/settings). Not for query-backed state.',
  every: 'Poll a query on a timer: `query orders every 5s` (also `500ms`, `2m`). Silent auto-refetch — keyed reconciliation updates only the rows that changed (no full re-render, no loading flash).',
  if: 'Conditional INSIDE an action body: `if <expr> { … } else { … }` — the only branching in actions (toggles, validation, add-or-remove).',
  when: 'Conditional render: `when <expr> { ... }`.',
  each: 'List render: `each <list> as <item> { ... }`. Optional `where`: `each posts as p where p.published { ... }` renders only matching items.',
  as: 'Names the item variable in an `each`.',
  where: 'Filters an `each` by a per-item condition: `each posts as p where p.published`. (Also the DataTable `where(...)` modifier.)',
  and: 'Logical AND.',
  or: 'Logical OR.',
  not: 'Logical NOT, e.g. `when not (cart.isEmpty)`.',
  contains: 'Case-insensitive substring match: `name contains @q`.',
};

export const ACTION_OPS = ['push', 'remove', 'patch', 'reset', 'toggle', 'set', 'create', 'update', 'delete', 'refetch'];
export const ACTION_OP_DOCS = {
  push: 'Append to a list state: `users.push(draft)` or an inline object `users.push({ name: draft.name, role: "admin" })` (auto-fills uuid fields). Prefer `patch` to edit in place; `remove where … ` + `push(…)` only if you truly need to reorder.',
  remove: 'Remove matching items locally (item fields bare): `users.remove where id == userId`. The param must be named differently from any field (the oracle flags `id == id`).',
  patch: 'Edit matching items IN PLACE (position-preserving): `todos.patch where id == todoId with { done: not done }`. Item fields are bare; list ONLY the fields that change. Use this to toggle/move/update an item instead of remove+push.',
  reset: 'Reset a state to its declared initial: `draft.reset()`.',
  toggle: 'Flip a bool state: `open.toggle()` (same as `open.set(not open)`).',
  set: 'Set a state value: `rating.set(v)` or an entity draft to an inline object: `draft.set({ name: c.name })`.',
  create: 'POST an item to a source-backed list, then append the result: `orders.create(draft)`.',
  update: 'PUT an item (by id) to a source-backed list, then replace it: `orders.update(order)`.',
  delete: 'DELETE an item (by id) from a source-backed list, then drop it: `orders.delete(order)`.',
  refetch: 'Re-run a query with N query-string params (paginate / search / filter): `products.refetch(q: term, page: n)`.',
};

export const PRIMITIVE_NAMES = Object.keys(PRIMITIVES);
