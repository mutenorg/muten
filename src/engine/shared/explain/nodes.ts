// explain/nodes: the findings about the tree a page draws (elements, parts, links, the names a screen reader says).

import type { Explanations } from '#engine/shared/types-explain.js';

export const NODES: Explanations = {
  'unknown-type': {
    means: 'A word stands where an element (a primitive like Stack, Text, Button) or a type (text, number, an entity) goes, and it is neither.',
    fix: 'Write the element or type it meant; the finding names the nearest one.',
    wrong: 'Stakc { Text "Hola" }', right: 'Stack { Text "Hola" }',
  },
  'unknown-part': {
    means: 'A call `Name(…)` names no part of the app, of a plugin, nor of this file.',
    fix: 'Fix the name, or create the part in src/parts/ (or enable the plugin that has it).',
    wrong: 'Topbr(title: "Hoy")', right: 'Topbar(title: "Hoy")',
  },
  'unknown-component': {
    means: 'A `Custom Name` has nothing to mount: no src/components/Name.js, no plugin ships one, no `use element|widget|react Name` brings it.',
    fix: 'Fix the name, write src/components/Name.js, or declare where it comes from with `use react Name from "…"`.',
    wrong: 'Custom Tciker inputs(every: 60000)', right: 'Custom Ticker inputs(every: 60000)',
  },
  'unknown-param': {
    means: 'A part reads `$name`, and `name` is not one of its parameters: inlined, it would read nothing.',
    fix: 'Read one of its parameters, or declare the parameter in `part Name(…)`.',
    wrong: 'part Drawer(open: bool) { Stack class("x" when $oepn) }', right: 'part Drawer(open: bool) { Stack class("x" when $open) }',
  },
  'unknown-arg': {
    means: 'A call passes an argument the part does not take, so the part never gets it (a warning: the app runs, without that value).',
    fix: 'Use one of the part\'s parameters, or add the parameter to the part.',
    wrong: 'Topbar(puased: no)', right: 'Topbar(paused: no)',
  },
  'part-arg-missing': {
    means: 'A part is called without a parameter it needs (one with no default).',
    fix: 'Pass it, or give the parameter a default in the part: `part Box(label: text = "")`.',
  },
  'part-cycle': {
    means: 'A part calls itself, directly or through another part. Parts are inlined at build, so it could never end.',
    fix: 'Remove the self-reference. A part that holds content uses `slot`, not a call to itself.',
  },
  'leaf-children': {
    means: 'An element that cannot hold children was given some: they are dropped and never render.',
    fix: 'Put them in a Stack (it holds children), with the text in a Span beside them.',
    wrong: 'Text "Total" { Icon "lucide:info" }', right: 'Stack class("row") { Span "Total"  Icon "lucide:info" }',
  },
  'missing-prop': {
    means: 'An element is missing something it needs to work (an Image its source, a Link its target…).',
    fix: 'Add what the finding names.',
  },
  'checkbox-prop': {
    means: 'A Checkbox has both `bind(…)` and `checked(…)`: it can own a bool or show one, not both.',
    fix: 'Keep `bind(state)` to own it, or `checked(expr) -> action` to show a value you do not own.',
  },
  'bind-type': {
    means: 'An input inside `each` binds the whole item; it can only edit one of its fields.',
    fix: 'Bind a field: `bind(item.title)`.',
    wrong: 'each todos as t { SearchField bind(t) }', right: 'each todos as t { SearchField bind(t.title) }',
  },
  'form-bind': {
    means: '`Form` renders an entity draft, and what it was given is not one.',
    fix: 'Give it a state typed with the entity (`draft = {} : User`), or build the form from inputs.',
  },
  'disabled-target': {
    means: '`disabled` was put on an element it does nothing to.',
    fix: 'Put it on the control (Button, an input, a Link), or remove it.',
  },
  'lazy-target': {
    means: '`lazy` holds back a Custom\'s mount until it nears the screen, and was put on an element drawn with the page.',
    fix: 'Put it on the Custom that loads something heavy (a map, a shader, a QR library), or remove it.',
    wrong: 'Stack lazy { … }', right: 'Custom Sky lazy inputs(tone: tone)',
  },
  'eager-target': {
    means: '`eager` loads an Image at once, and this element has no image.',
    fix: 'Remove `eager`, or put it on the Image.',
  },
  'group-target': {
    means: '`group()` makes Details open one at a time, and this element has nothing to open.',
    fix: 'Put `group()` on the Details.',
  },
  'encoding-target': {
    means: '`kind` / `color` are a Chart\'s, and were put on another element.',
    fix: 'Move them to the Chart, or remove them.',
  },
  'id-target': {
    means: 'Page already owns the id the skip-link lands on.',
    fix: 'Put the id on a Section or Stack inside the Page.',
  },
  'rowaction-context': {
    means: 'RowAction draws a button in each row of a DataTable, and it is outside one.',
    fix: 'Use a Button for an action on its own.',
  },
  'chart-kind': { means: 'A Chart kind that is not one of bar / line / area / point / scatter / pie / donut.', fix: 'Use one of those; the finding names the nearest.' },
  'chart-field': { means: 'A Chart axis is an expression; it must be a field of the list\'s items.', fix: 'Name the field: `x(month)`.' },
  'chart-not-list': { means: 'A Chart plots a list, and what it was given is not one.', fix: 'Give it a `list<…>` state, a query, a get, or a store list.' },
  'datatable-not-list': { means: 'A DataTable shows a list, and what it was given is not one.', fix: 'Give it a `list<…>` state, a query, a get, or a store list.' },
  'unknown-column': { means: 'A DataTable column names no field of the rows.', fix: 'Use a field of the entity; the finding names the nearest.' },
  'icon-name': {
    means: 'An Icon name comes from data. Icons are inlined as SVG at build, so the name must be written: "set:name".',
    fix: 'Write the name, or switch between written names with `when` / `match`.',
    wrong: 'Icon "{item.icon}"', right: 'match item.kind { pay -> Icon "lucide:wallet"  ship -> Icon "lucide:truck" }',
  },
  'unknown-class': { means: 'A class that is neither in the stylesheet nor a token of the styling plugin.', fix: 'Fix the name, or define the class.' },
  'unknown-route': {
    means: 'A Link goes to a path no route declares: it would go nowhere.',
    fix: 'Fix the path, or declare the route in app.muten.',
    wrong: 'Link "Precios" -> "/pricng"', right: 'Link "Precios" -> "/pricing"',
  },
  'unknown-anchor': { means: 'A link to `#id` lands on no element with that id on the page (or, from a layout, on every page in it).', fix: 'Fix the id, or give the target `id("…")`.' },
  'self-link': {
    means: 'A link goes to the page it is on: clicking it does nothing (a warning).',
    fix: 'If it marks where you are, show it as current instead of linking; if it is a view of this page, use state.',
  },
  'field-unnamed': {
    means: 'An input has no name a screen reader can say.',
    fix: 'Give it its text, or `aria(label: "…")` when a visible label sits next to it.',
    wrong: 'SearchField bind(qty)', right: 'SearchField bind(qty) "Cantidad"',
  },
  'control-unnamed': {
    means: 'A button or link shows only an icon, so a screen reader announces nothing.',
    fix: 'Add `aria(label: "…")`, or words inside it.',
    wrong: 'Button -> close { Icon "lucide:x" }', right: 'Button -> close aria(label: "Cerrar") { Icon "lucide:x" }',
  },
  'heading-many-h1': {
    means: 'A page has more than one Title at h1; one says what the page is (a warning).',
    fix: 'Keep one h1 and make the rest sections: `Title "…" h2`.',
  },
  'dup-node': { means: 'The same node is used twice in the tree (an internal fault).', fix: 'Report it: muten built a tree it should not have.' },
  'missing-node': { means: 'The tree points to a node that does not exist (an internal fault).', fix: 'Report it: muten built a tree it should not have.' },
  'no-root': { means: 'A page has no top-level node.', fix: 'Give it one root, e.g. `Page { … }`.' },
  'react-list-node': {
    means: 'A muten element sits in a row of a list inside a React component: it is built once and would show in one row only.',
    fix: 'Use the library\'s own way to render each row.',
  },
  'syntax': { means: 'The file does not read as muten at that place.', fix: 'Fix what the message names; a keyword one slip away is suggested (`prat` → `part`).' },
};
