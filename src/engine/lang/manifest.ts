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
  Section: {
    props: {}, children: true,
    doc: 'A thematic section of a page (<section>) - a band/region that usually has its own heading (give it a Title). Use it to structure a landing or a long page; lay it out with class(). Prefer Section over a plain Stack when the group is a distinct part of the document.',
    snippet: 'Section class("py-16") {\n\t$0\n}',
  },
  Article: {
    props: {}, children: true,
    doc: 'Self-contained content (<article>) - a blog post, a product card, a comment, a notification: anything that would still make sense pulled out on its own. Use it for repeated content items; lay it out with class().',
    snippet: 'Article class("flex flex-col gap-2") {\n\t$0\n}',
  },
  List: {
    props: {}, children: true,
    doc: 'A semantic list (<ul>; add the `ordered` keyword for <ol>). Its direct children render as <li> - usually one `each`. Use it for ANY real list (menus, feeds, results, steps) so screen readers announce "list, N items"; reach for a plain Stack only when the group is not a list. `List class("flex flex-col gap-2") { each todos as t { Span "{t.title}" } }` · ordered: `List ordered { each steps as s { Text "{s}" } }`. Style the <li> via the child you put inside; bullets are off when you use flex/grid (add list-disc to keep them).',
    snippet: 'List class("flex flex-col gap-2") {\n\teach ${1:items} as ${2:item} {\n\t\t$0\n\t}\n}',
  },
  Details: {
    string: 'summary', props: { summary: 'text' }, children: true, interp: true,
    doc: 'Native disclosure / accordion (<details> + <summary>). The positional string is the summary (the clickable header; it interpolates); the children are the collapsible content. Zero state, zero JS - the browser handles the toggle, keyboard, and a11y. `Details "Shipping & returns" { Text "Free returns within 30 days." }`. Add `open` to start expanded: `Details "FAQ" open { … }`. Use it for FAQs, "show more", optional detail; reach for state + when only when you need a controlled or animated panel.',
    snippet: 'Details "${1:Summary}" {\n\t$0\n}',
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
    doc: 'Icon from ANY library via Iconify `set:name`: `Icon "lucide:settings"`, `Icon "tabler:home"`. Inlined as SVG at build (only the icons you use ship — tree-shaken, no runtime). Color + size via class() (uses currentColor + 1em). The set must be installed: `npm i -D @iconify-json/<set>` (scaffold pre-installs lucide). Name is a STATIC literal (resolved at build). Data-driven? per-VALUE (status/type) → `match item.status { active -> Icon "lucide:check"  … }` (each arm tree-shakes); an icon whose URL is in the data → `Image "{item.iconUrl}"`.',
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
  Password: {
    string: 'placeholder', props: { bind: 'state', placeholder: 'text?' }, children: false, interp: true,
    doc: 'Masked password input two-way bound to a text state (usable OUTSIDE a Form). Gate the next action reactively: `Password bind(pw) "Password"` + `Button "Next" disabled when pw.length < 8`.',
    snippet: 'Password bind(${1:pw}) "${2:Password}"',
  },
  Textarea: {
    string: 'placeholder', props: { bind: 'state', placeholder: 'text?' }, children: false, interp: true,
    doc: 'Multi-line text input (a standalone `<textarea>`) two-way bound to a text state, usable OUTSIDE a Form — for a message, comment, bio or description: `Textarea bind(message) "Write a message…"`. Fires `on(enter: send)` like SearchField.',
    snippet: 'Textarea bind(${1:message}) "${2:Write a message…}"',
  },
  Select: {
    string: 'placeholder', props: { bind: 'state', options: 'idents', placeholder: 'text?' }, children: false,
    doc: 'Dropdown bound to a text state with a fixed option list: `Select bind(role) options(founder, engineer, other) "Pick a role"`. The placeholder is a non-selectable prompt shown while the value is empty.',
    snippet: 'Select bind(${1:role}) options(${2:a, b, c})',
  },
  Checkbox: {
    string: 'label', props: { bind: 'state?', checked: 'expr?', label: 'text?' }, children: false, interp: true,
    doc: 'Checkbox for a bool. `bind(agree)` owns a page state (two-way). For a value you do NOT own — a store/query list row — use `checked(<bool>)` to display it and `-> action` to toggle: `Checkbox checked(t.done) -> todos.toggle(t.id)`. Exactly one of bind / checked.',
    snippet: 'Checkbox bind(${1:agree}) "${2:I accept the terms}"',
  },
  Number: {
    string: 'placeholder', props: { bind: 'state', min: 'expr?', max: 'expr?', step: 'expr?', placeholder: 'text?' }, children: false, interp: true,
    doc: 'Numeric input two-way bound to a NUMBER state (usable outside a Form): `Number bind(qty) min(1) max(99)`. Optional `min`/`max`/`step` (numbers or a state).',
    snippet: 'Number bind(${1:qty}) min(${2:1}) max(${3:99})',
  },
  Range: {
    props: { bind: 'state', min: 'expr?', max: 'expr?', step: 'expr?' }, children: false,
    doc: 'Slider (`<input type=range>`) two-way bound to a NUMBER state: `Range bind(volume) min(0) max(100) step(5)`. Defaults 0..100 step 1. Style the track/thumb with your CSS (accent-color, ::-webkit-slider-thumb).',
    snippet: 'Range bind(${1:volume}) min(${2:0}) max(${3:100})',
  },
  Date: {
    string: 'placeholder', props: { bind: 'state', placeholder: 'text?' }, children: false, interp: true,
    doc: 'Native date picker (`<input type=date>`) two-way bound to a date/text state (ISO `YYYY-MM-DD`): `Date bind(due)`. The browser supplies the calendar popup — for a single date this is the whole date picker, no Custom. (A multi-month / range calendar is out of scope: it needs day-range generation.)',
    snippet: 'Date bind(${1:due})',
  },
  DataTable: {
    props: { data: 'state', where: 'clauses?', columns: 'fields' }, children: true,
    doc: 'Reactive table over a list/query. Static `where` filters are pushed to the query; dynamic ones stay reactive.',
    snippet: 'DataTable @${1:items}\n\tcolumns(${2:name})',
  },
  Chart: {
    string: 'label', props: { data: 'state', kind: 'ident?', x: 'ident', y: 'ident', color: 'ident?' }, children: false, interp: true,
    doc: 'Native chart — SVG, zero JS. Declare the data + mark `kind` + `x`/`y` encodings from entity FIELDS; scales, axes and layout are automatic and reactive: `Chart @sales "Revenue by month" kind(bar) x(month) y(revenue)`. The optional string is the title. kind = bar | line | area | point (default bar). `color(field)` colors + adds a legend. Style via CSS: `.mu-chart-bar` / `.mu-chart-line` / `.mu-chart-area` / `.mu-chart-dot` / `.mu-chart-grid` / `.mu-chart-title` / `.mu-chart-legend` (colors read `theme.muten` `--color-*`).',
    snippet: 'Chart @${1:data} "${2:Title}" kind(${3:bar}) x(${4:label}) y(${5:value})',
  },
  Svg: {
    props: { viewBox: 'text?' }, children: true,
    doc: 'Native SVG canvas — the vector layer under Chart. Declare marks (Rect/Line/Circle/Path/Group) from data with `each`; coordinates are number expressions (use the `map` built-in for scales). `Svg viewBox("0 0 100 100") { each pts as p { Circle cx(p.x) cy(p.y) r(2) } }`. Style via CSS on your own class().',
    snippet: 'Svg viewBox("0 0 ${1:100} ${2:100}") {\n\t$0\n}',
  },
  Rect: {
    props: { x: 'expr?', y: 'expr?', w: 'expr?', h: 'expr?', rx: 'expr?' }, children: false,
    doc: 'SVG rectangle: `Rect x(0) y(map(v,0,max,100,0)) w(20) h(...)`. Coordinates are number expressions. Fill/stroke via class() + CSS.',
    snippet: 'Rect x(${1:0}) y(${2:0}) w(${3:10}) h(${4:10})',
  },
  Line: {
    props: { x1: 'expr?', y1: 'expr?', x2: 'expr?', y2: 'expr?' }, children: false,
    doc: 'SVG line between two points: `Line x1(0) y1(0) x2(100) y2(50)`. Stroke via class() + CSS.',
    snippet: 'Line x1(${1:0}) y1(${2:0}) x2(${3:100}) y2(${4:0})',
  },
  Circle: {
    props: { cx: 'expr?', cy: 'expr?', r: 'expr?' }, children: false,
    doc: 'SVG circle: `Circle cx(map(p.x,0,mx,0,100)) cy(...) r(3)`. Fill via class() + CSS. The mark for scatter plots.',
    snippet: 'Circle cx(${1:0}) cy(${2:0}) r(${3:3})',
  },
  Path: {
    props: { d: 'text?' }, children: false,
    doc: 'SVG path — the `d` string interpolates: `Path d("M0,0 L{w},{h} Z")`. For arbitrary shapes / a computed outline.',
    snippet: 'Path d("${1:M0,0 L10,10}")',
  },
  Group: {
    props: { transform: 'text?' }, children: true,
    doc: 'SVG group `<g>` — a transform/organizational wrapper for marks: `Group transform("translate(10,0)") { … }`.',
    snippet: 'Group {\n\t$0\n}',
  },
  Arc: {
    props: { cx: 'expr?', cy: 'expr?', r: 'expr?', start: 'expr?', end: 'expr?', inner: 'expr?' }, children: false,
    doc: 'SVG arc/sector — the radial workhorse (pie slice, donut segment, gauge). Sweeps `start`→`end` DEGREES (0 = top, clockwise) at radius `r` around (`cx`,`cy`); `inner(r2)` makes a donut ring. `Arc cx(80) cy(80) r(70) start(0) end(120) inner(40)`. Fill via class() + CSS.',
    snippet: 'Arc cx(${1:80}) cy(${2:80}) r(${3:70}) start(${4:0}) end(${5:90})',
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
    props: { list: 'expr', as: 'ident', index: 'ident?', filter: 'expr?' }, children: true, control: true,
    doc: 'List render: `each <list> as <item> { ... }`. Add a 0-based reactive index with a comma: `each <list> as <item>, <i> { ... }` (i = position; rank when sorted). Filter with `where`: `each posts as p where p.published { ... }`. The item (and index) are scope variables.',
    snippet: 'each ${1:items} as ${2:item} {\n\t$0\n}',
  },
  Custom: {
    props: { component: 'name', inputs: 'map?', on: 'map?' }, children: false,
    doc: 'Escape hatch (§7): mount a host component from `src/components/<Name>.js`. Opaque to the IR; connected via inputs/on.',
    snippet: 'Custom ${1:Name} inputs(${2:prop}: ${3}) on(${4:event}: ${5:action})',
  },
};

export const MODIFIERS = ['bind', 'submit', 'where', 'columns', 'options', 'class', 'alt', 'inputs', 'on', 'aria', 'style', 'disabled', 'draggable', 'droptarget', 'min', 'max', 'step'];
export const MODIFIER_DOCS = {
  bind: 'Two-way bind to a @state, e.g. `bind @search`.',
  submit: 'Action to run on form submit, e.g. `submit createUser`.',
  where: 'Filter clauses: `where(role == admin, name contains @q)`.',
  columns: 'Columns to show: `columns(name, email, role)`.',
  options: 'The fixed value list of a standalone `Select`: `Select bind(role) options(admin, member, guest)`.',
  class: 'The ONE way to style: raw CSS class(es) — utility classes (`class("flex flex-row gap-4")`) or your own CSS (`class("card")`, backed by styles.css using theme.muten CSS vars). Muten stays agnostic about appearance: any class string passes straight through.',
  alt: 'Required accessible/SEO text for an Image: `alt "{p.title}"`. Use "" for decorative images.',
  inputs: 'Custom component inputs: `inputs(data: @sales)`.',
  on: 'Custom component events wired to actions: `on(select: pick)`.',
  aria: 'Accessibility attributes on ANY node — the bounded way to write `aria-*`/`role` (muten is HTML + logic): `aria(label: "Close", role: "dialog", expanded: menuOpen)`. Each key → `aria-<key>`; `role` → `role`. A literal value is a static attribute; a value that reads state is REACTIVE (e.g. `aria(expanded: open)` keeps aria-expanded in sync). Use this for an accessible interactive widget instead of escaping to Custom.',
  style: 'The bounded way to bind a DYNAMIC CSS value to state — for progress bars, data-driven sizes, transforms: `style(w: "{pct}%")`. Each key becomes a CSS custom property `--key` (muten prepends `--`, so it can ONLY set variables, never arbitrary properties — no competing with class()). The value is an interpolated string; it is REACTIVE when it reads state. Your CSS consumes it: `.bar { width: var(--w); }`. Use class() for STATIC styling; use style() only for a value that changes at runtime.',
  draggable: 'Make an element a drag source carrying an id: `draggable(item.id)`. A pointer-based floating clone tracks the cursor (touch-ready, styled via .mu-dnd-overlay / .mu-dnd-ghost). The drop target reads the id.',
  droptarget: 'A drop zone: `droptarget("done") on(drop: move)` fires `move(draggedId, "done")`. Nested zones are safe — the INNERMOST zone under the pointer wins (no double-fire). muten owns the data (do the `patch` in the action).',
  disabled: 'Reactively disable a form control (Button/RowAction/SearchField/Password/Select/Checkbox/Number/Range/Form): `disabled when <cond>` sets the real `disabled` property (e.g. `Button "Next" -> next disabled when pw.length < 8`). Bare `disabled` = always disabled. Prefer this over a fake CSS class + aria(disabled) hand-roll; it does nothing on non-control nodes (the oracle flags it).',
  min: 'Minimum value of a Number/Range input: `Range bind(v) min(0)`. A number or a state (reactive).',
  max: 'Maximum value of a Number/Range input: `Range bind(v) max(100)`. A number or a state (reactive).',
  step: 'Step increment of a Number/Range input: `Range bind(v) step(5)`. A number or a state.',
};

// Built-in formatting functions: callable like a `use`'d function but ALWAYS available (no import). The bounded
// answer to "muten has no dates/string ops" — a FIXED set, so the language stays small and the oracle knows them.
export const BUILTINS = ['upper', 'lower', 'initial', 'truncate', 'money', 'map', 'sin', 'cos', 'sqrt', 'abs', 'round', 'floor', 'ceil', 'pow', 'min', 'max', 'pi', 'ago', 'date', 'time', 'datetime', 'calendar', 'weekday', 'now', 'isToday', 'isPast', 'isFuture', 'isEmail', 'before', 'after', 'daysUntil', 'dayKey', 'addDays'];
// Identifiers the emitted page/store module already binds — the signals runtime (`signal`/`effect`/…), the
// injected data layer (`query`, `mount`), and the formatting BUILTINS — all in the SAME scope as a state/get/
// action const. Naming a state `query` compiles to `const query = …` colliding with the runtime's `query`
// → `SyntaxError: Identifier 'query' already declared`: a BLANK page that lints green. The oracle rejects these
// (plus any `__`-prefixed name — every runtime internal uses that prefix). Keep in sync with emit.ts's dataLayer.
export const RESERVED_NAMES = [...BUILTINS, 'signal', 'computed', 'effect', 'root', 'onCleanup', 'query', 'mount', 'app'];
export const BUILTIN_DOCS: { [k: string]: string } = {
  upper: 'upper(text) → UPPERCASE.',
  lower: 'lower(text) → lowercase.',
  initial: 'initial(name) → first letter, uppercased — avatar initials: `Text "{initial(user.name)}"`.',
  truncate: 'truncate(text, n) → first n characters, + "…" if longer.',
  money: 'money(number[, "USD"]) → localized currency, e.g. $1,234.56.',
  map: 'map(v, inLo, inHi, outLo, outHi) → linear scale, e.g. a value to an SVG coordinate: `Circle cy(map(p.val, 0, max, 100, 0))`.',
  sin: 'sin(radians) → sine. For a radial position: `cx(cx0 + r * cos(a))`, `cy(cy0 + r * sin(a))`. Degrees → radians with `a * pi() / 180`.',
  cos: 'cos(radians) → cosine (see sin).',
  sqrt: 'sqrt(n) → square root (0 for negatives). Bubble radius from area: `r(sqrt(p.value))`.',
  abs: 'abs(n) → absolute value.',
  round: 'round(n) → nearest integer.',
  floor: 'floor(n) → round down.',
  ceil: 'ceil(n) → round up.',
  pow: 'pow(base, exp) → base^exp.',
  min: 'min(a, b) → the smaller of two numbers (2-arg; for a list minimum use `list.min by field`).',
  max: 'max(a, b) → the larger of two numbers (2-arg; for a list maximum use `list.max by field`).',
  pi: 'pi() → 3.14159… (the constant, as a call).',
  ago: 'ago(isoText) → relative time: "just now" / "5m ago" / "3h ago" / "2d ago" (the timestamp is a text field holding an ISO string).',
  date: 'date(isoText) → short date, e.g. "Jan 5".',
  time: 'time(isoText) → short time, e.g. "3:42 PM".',
  datetime: 'datetime(isoText) → full date + time, e.g. "Jan 5, 2024, 3:42 PM".',
  calendar: 'calendar(isoText) → chat/feed-style smart timestamp: "Today at 3:42 PM" / "Yesterday at 3:42 PM" / "Jan 5 at 3:42 PM". The right default for a message timestamp.',
  weekday: 'weekday(isoText) → the day name, e.g. "Monday".',
  now: 'now() → the CURRENT time as an ISO string. Use it to stamp a new record before sending: `messages.push({ text: draft, time: now() })`. (Pairs with ago/date/time, which format a timestamp.)',
  isToday: 'isToday(isoText) → bool: is the date today? For `when`/grouping: `when isToday(msg.time) { … }`.',
  isPast: 'isPast(isoText) → bool: is the date before now? (deadlines, expiry).',
  isFuture: 'isFuture(isoText) → bool: is the date after now? (upcoming events).',
  isEmail: 'isEmail(text) → bool: is it a valid email address? For hand-rolled form validation (a `Form` checks `email` fields on submit; this is the same check as an expression): `get emailOk = isEmail(email)` then `Button "Save" -> save disabled when not emailOk`.',
  before: 'before(text, sep) → the part of `text` BEFORE the first `sep` (whole string if not found): `before(user.email, "@")` → the username; `before(name, " ")` → first name.',
  after: 'after(text, sep) → the part of `text` AFTER the first `sep` (empty if not found): `after(user.email, "@")` → the domain.',
  daysUntil: 'daysUntil(isoText) → whole days from today to the date (negative if past, 0 = today): `Span "in {daysUntil(appt.date)} days"`. Pair with isToday/isPast for nicer labels.',
  dayKey: 'dayKey(isoText) → the calendar day as "YYYY-MM-DD" (drops the time). Match an event to a day cell or group by day: `when dayKey(event.date) == dayKey(cell.date) { … }`.',
  addDays: 'addDays(isoText, n) → the date shifted by n days (n may be negative), as an ISO string. Compute a due date or a range bound.',
};
export const KEYWORDS = ['screen', 'entity', 'state', 'store', 'const', 'theme', 'get', 'effect', 'action', 'mutates', 'mock', 'sources', 'api', 'meta', 'routes', 'shell', 'guard', 'else', 'part', 'param', 'query', 'every', 'live', 'persist', 'post', 'put', 'delete', 'body', 'into', 'if', 'when', 'each', 'as', 'where', 'by', 'with', 'and', 'or', 'not', 'contains', 'use', 'from'];
export const KEYWORD_DOCS = {
  screen: 'Declares the screen name: `screen users_dashboard`.',
  entity: 'Declares a data shape + validation: `entity User { name text required  email email required  zip text pattern:"^\\d{5}$" }` (implicit uuid id). Constraints: `required`, `min:N`, `max:N`, `pattern:"<regex>"`. An `email` field validates its format on submit; `pattern` matches a value against your regex.',
  state: 'Declares reactive state: `state { search = "" : text  users = query listUsers : list<User> }`.',
  store: 'App-GLOBAL reactive state (shared across pages, no prop drilling): `store { cart = [] : list<number> }`. Referenced by name like local state.',
  const: 'A compile-time IMMUTABLE scalar, inlined (never reactive): `const TAX = 0.21`. Scalars only — structured config uses a block (e.g. theme).',
  theme: 'The project theme block (theme.muten): `theme { space { md "16px" }  breakpoints { md "768px" } }`. Supplies the token SCALE; the engine owns only the vocabulary. The reset/base CSS lives in your stylesheet.',
  get: 'A `.store` derived/memoized value (getter): `get total = items.length`. Read as `domain.total`, recomputes when deps change.',
  effect: 'A reactive side-effect: `effect { ... }`. Runs on mount and re-runs when the state it reads changes (Angular-style). Valid in a `.store` (app-global) AND on a PAGE — the page-level home for ON-MOUNT side effects (initialize a 3rd-party SDK, analytics, focus). Body is mutations + `use`-fn calls.',
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
  every: 'NOT SUPPORTED — `query x every Ns` (polling) is rejected by the oracle (it would silently never refresh). For real-time use `query x live` (a WebSocket); for periodic or triggered refresh, call `refetch()` from an action.',
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
