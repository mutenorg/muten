// Language manifest — the SINGLE source of the vocabulary AND its documentation.
//
// Consulted by: parse (string-props + modifiers), validate (valid types/ops),
// the linter (lint.js) and the editor autocomplete + hovers (tools/screen-vscode).
// Each primitive carries a one-line `doc` + a completion `snippet`. Adding/changing the
// language = edit here (and its render in compile.js), then regenerate the highlight.

import { TOKENS } from './theme.js';

// Each primitive: `string` = positional prop; `props` = props with a type hint
// (text/state/action/fields/tokens/expr/name/map; "?" marks optional); `children` = accepts { };
// `control` = a control-flow keyword node (typed lowercase); `doc` + `snippet` for autocomplete.
export const PRIMITIVES = {
  Page: {
    string: 'title', props: { title: 'text?', style: 'tokens?' }, children: true,
    doc: 'Root container of a screen. Renders as a card by default (override `.page` for full-width pages).',
    snippet: 'Page "${1:Title}" {\n\t$0\n}',
  },
  Stack: {
    props: { style: 'tokens?' }, children: true,
    doc: 'Vertical layout container (flex column). Use `style(surface, padding.md, gap.sm)` to make a card.',
    snippet: 'Stack {\n\t$0\n}',
  },
  Text: {
    string: 'value', props: { value: 'text', style: 'tokens?' }, children: false,
    doc: 'Text. Interpolates state reactively: `Text "Hi, {user.name}"`.',
    snippet: 'Text "$1"',
  },
  Image: {
    string: 'src', props: { src: 'text', style: 'tokens?' }, children: false,
    doc: 'An image. The `src` interpolates state: `Image "{character.image}"`.',
    snippet: 'Image "{${1:item.image}}"',
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
    string: 'label', props: { label: 'text', action: 'action?', arg: 'expr?', style: 'tokens?' }, children: false,
    doc: 'Clickable button that runs an action. Works anywhere, including inside `each`.',
    snippet: 'Button "${1:label}" -> ${2:action}($3)',
  },
  Form: {
    string: 'submitLabel', props: { bind: 'state', submit: 'action', submitLabel: 'text?' }, children: false,
    doc: 'Auto-form: one field per entity field, two-way bound to a draft state.',
    snippet: 'Form bind @${1:draft} submit ${2:createItem} "${3:Save}"',
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

export const MODIFIERS = ['bind', 'submit', 'where', 'columns', 'style', 'inputs', 'on'];
export const MODIFIER_DOCS = {
  bind: 'Two-way bind to a @state, e.g. `bind @search`.',
  submit: 'Action to run on form submit, e.g. `submit createUser`.',
  where: 'Filter clauses: `where(role == admin, name contains @q)`.',
  columns: 'Columns to show: `columns(name, email, role)`.',
  style: 'Semantic style tokens: `style(surface, padding.lg, rounded.md)`.',
  inputs: 'Custom component inputs: `inputs(data: @sales)`.',
  on: 'Custom component events wired to actions: `on(select: pick)`.',
};

export const KEYWORDS = ['screen', 'entity', 'state', 'action', 'mutates', 'mock', 'sources', 'routes', 'part', 'query', 'when', 'each', 'as', 'and', 'or', 'not', 'contains'];
export const KEYWORD_DOCS = {
  screen: 'Declares the screen name: `screen users_dashboard`.',
  entity: 'Declares a data shape: `entity User { name text  role admin | member }` (implicit uuid id).',
  state: 'Declares reactive state: `state { search = "" : text  users = query listUsers : list<User> }`.',
  action: 'Declares a mutation: `action delete mutates users <- id { users.remove(u => u.id == id) }`.',
  mutates: 'Lists the state an action may mutate — the linter enforces it.',
  mock: 'Inline mock data for queries: `mock { listUsers: [ { name: "Ana", role: admin } ] }`.',
  sources: 'Real data sources for queries: `sources { listChars: { url: "https://api...", at: "results" } }`.',
  routes: 'App root (app.screen): maps URLs to pages, `routes { /url -> page }`. The single source of truth the AI reads.',
  part: 'Reusable composition: `part Card(item: Item, onPick: action) { ... }`. Pass OBJECTS (`$item.field`) and ACTION callbacks (`-> $onPick(...)`). Inlined at build time.',
  query: 'An async data source. The state exposes `.loading`, `.error` and `.data`.',
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
export const TOKEN_NAMES = Object.keys(TOKENS);
export { TOKENS };
