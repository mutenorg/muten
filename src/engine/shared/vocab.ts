// vocab: single typed source for every string the parser matches or emits.
// No magic strings downstream: token kinds, punctuation, keywords, node types,
// operators, statement ops, and modifiers all have a name here. String enums are
// used so members are assignable to `string` and compare cleanly in at()/eat().

/** Token kinds the lexer emits. */
export enum Tk {
  Ident = 'ident',
  String = 'string',
  Number = 'number',
  Ref = 'ref',           // @state
  Param = 'param',       // $partParam
  Punct = 'punct',       // single char (see Pn)
  Arrow = 'arrow',       // ->
  LArrow = 'larrow',     // <-
  Eq = 'eq',             // ==
  Neq = 'neq',           // !=
  Lte = 'lte',           // <=
  Gte = 'gte',           // >=
  FatArrow = 'fatarrow', // =>
  Raw = 'raw',           // the signature and TypeScript body of a `fn`, as written (lexer.ts)
  Eof = 'eof',
}

/** Single-character punctuation: the `v` of a Punct token. */
export enum Pn {
  BraceL = '{', BraceR = '}',
  ParenL = '(', ParenR = ')',
  BrackL = '[', BrackR = ']',
  Comma = ',', Pipe = '|', Colon = ':', Assign = '=',
  Lt = '<', Gt = '>', Dot = '.', Slash = '/',
  Plus = '+', Star = '*', Question = '?', Dash = '-',
}

/** Keywords and reserved idents the parser matches. */
export enum Kw {
  Screen = 'screen', Entity = 'entity', State = 'state', Store = 'store',
  Get = 'get', Fn = 'fn', Settle = 'settle', Effect = 'effect', Action = 'action', Mutates = 'mutates', Failed = 'failed',
  Mock = 'mock', Sources = 'sources', Routes = 'routes', Shell = 'shell', Layout = 'layout', In = 'in', Default = 'default', Without = 'without',
  Part = 'part', Const = 'const', Theme = 'theme', Query = 'query', Every = 'every', Live = 'live', Persist = 'persist', Param = 'param', Api = 'api', Body = 'body', Into = 'into', Meta = 'meta',
  Use = 'use', From = 'from',
  When = 'when', Each = 'each', Match = 'match', As = 'as', Where = 'where', By = 'by', With = 'with', If = 'if', Else = 'else', Ordered = 'ordered', Open = 'open', Head = 'head',
  Guard = 'guard', Not = 'not', And = 'and', Or = 'or', Contains = 'contains',
  Required = 'required', Min = 'min', Max = 'max', Pattern = 'pattern',
  True = 'true', False = 'false', Null = 'null',
}

/** Primitive / node type names (the full vocabulary the parser builds and the compiler emits). */
export enum Nt {
  // containers (semantic landmarks + layout)
  Shell = 'Shell', Layout = 'Layout', Header = 'Header', Nav = 'Nav', Sidebar = 'Sidebar', Footer = 'Footer', Page = 'Page', Stack = 'Stack',
  Section = 'Section', Article = 'Article', List = 'List', Details = 'Details',
  // native semantic table: Table groups its Row children into <thead>/<tbody>, Row -> <tr>, Cell -> <td>/<th>
  Table = 'Table', Row = 'Row', Cell = 'Cell',
  // content
  Text = 'Text', Title = 'Title', Span = 'Span', Image = 'Image', Icon = 'Icon', Video = 'Video',
  Canvas = 'Canvas',
  Audio = 'Audio',
  File = 'File',     // picks files (or takes them dropped on it), bound to a `file` / `list<file>` state   // a sound file with the browser's player: `Audio "nota.mp3" controls` (a voice note, a podcast)   // a <canvas> a package draws on (`new Chart("sales", …)`, a shader): give it an id("…")
  // interactive
  Link = 'Link', Button = 'Button', Form = 'Form', SearchField = 'SearchField',
  Textarea = 'Textarea',   // standalone multi-line text input (<textarea>) two-way bound to a text state — for a message/comment/bio/description outside a Form
  Password = 'Password', Select = 'Select', Checkbox = 'Checkbox',   // standalone bound inputs (the same controls a Form renders, usable directly outside one)
  Number = 'Number', Range = 'Range',   // numeric inputs bound to a number state: Number = <input type=number>, Range = a slider (<input type=range>)
  Date = 'Date',   // standalone native date picker (<input type=date>) bound to a date/text state
  DataTable = 'DataTable', RowAction = 'RowAction', Custom = 'Custom',
  Chart = 'Chart',   // native dataviz: declare data + mark kind + x/y/color encodings; the compiler emits SVG + scales + axes
  // native vector layer (the escape UNDER the Chart grammar — declare arbitrary marks from data, oracle-visible)
  Svg = 'Svg', Rect = 'Rect', Line = 'Line', Circle = 'Circle', Path = 'Path', Group = 'Group', Arc = 'Arc',
  // control flow + outlet
  When = 'When', Each = 'Each', Slot = 'slot',
}

/** Known NON-primitives the model reaches for from its JS/React/HTML prior — mapped to the muten way. When it writes an
 * HTML tag (`<div>`) or a component name (`Modal`/`Card`) that isn't a primitive, the compiler recognizes it and hands
 * back the exact declarative solution, instead of a fuzzy typo guess or letting it invent a primitive. Keys lower-cased. */
export const NON_PRIMITIVES: { [name: string]: string } = {
  // HTML tags → the semantic primitive
  div: 'a `Stack` (vertical) — horizontal is `Stack class("flex flex-row")`', span: 'a `Span "…"`', p: 'a `Text "…"`',
  h1: 'a `Title "…" h1`', h2: 'a `Title "…" h2`', h3: 'a `Title "…" h3`', h4: 'a `Title "…" h4`', h5: 'a `Title "…" h5`', h6: 'a `Title "…" h6`',
  img: 'an `Image "url" alt("…")`', a: 'a `Link "…" -> "/path"`', button: 'a `Button "…" -> action`',
  input: 'a bound input: `SearchField bind(x)` (text) · `Number bind(n)` · `Date bind(d)` · `Checkbox checked(b) -> t`', textarea: 'a `Textarea bind(x) "…"`',
  select: 'a `Select bind(x) options(A, B)`', option: 'the `options(…)` list on `Select`', form: 'a `Form bind(draft) submit(save)` — or just the inputs + a `Button`',
  table: 'a `Table { Row head { Cell "…" } Row { Cell "…" } }` (static/authored) — or `DataTable @rows columns(a, b)` (data-bound)',
  thead: 'a `Row head { Cell … }` inside a `Table`', tbody: 'the body `Row`s inside a `Table`', tfoot: 'the last body `Row`s of a `Table`',
  tr: 'a `Row { Cell … }` inside a `Table` (add `head` for a header row)', td: 'a `Cell "…"` inside a `Row`', th: 'a `Cell "…"` inside a `Row head`', caption: 'a `Title`/`Text` before the `Table`',
  ul: 'a `List` or `each items as x { … }`', ol: 'an `each items as x { … }`', li: 'the `each` body',
  section: 'a `Section`', nav: 'a `Nav`', header: 'a `Header`', footer: 'a `Footer`', aside: 'a `Sidebar`', main: 'a `Page`', article: 'an `Article`',
  details: 'a `Details`', summary: 'the first child of `Details`', label: 'a `Span` before the input (inputs take a placeholder string)',
  svg: 'an `Svg { Rect/Line/Circle/Path }` — or a `Chart` for data', video: 'a `Video "clip.mp4" controls`', iframe: 'a `Custom` (last resort)', canvas: 'a `Custom` (last resort)',
  // React / component-library idioms → the declarative muten pattern
  card: 'a `Stack class("rounded-lg border bg-card p-4") { … }`', badge: 'a `Span "…" class("badge")`', chip: 'a `Span "…" class("badge")`',
  avatar: 'an `Image` (or `{initial(name)}` in a rounded `Span`)', modal: 'a bool state + `when open { … }` (no component — `open = false : bool`, `Button -> toggleOpen`, `when open { … }`)',
  dialog: 'a bool state + `when open { … }`', drawer: 'a bool state + `when open { … }`', popover: 'a bool state + `when open { … }`',
  dropdown: 'a bool state + `when open { … }` + `class(open when open)`', menu: 'a bool state + `when open { … }`', tooltip: 'a `group` on the parent + `group-hover:` classes on the tip',
  tabs: 'a `text` state + a button group + `when tab == "x" { … }`', tab: 'one arm of the `when tab == "x"`', accordion: 'a `Details` (or a bool state + `when …`)',
  grid: 'a `Stack class("grid grid-cols-3 gap-4")`', row: 'a `Stack class("flex flex-row")`', col: 'a `Stack`', flex: 'a `Stack class("flex …")`', box: 'a `Stack`',
  container: 'a `Stack class("mx-auto w-full max-w-6xl px-6")`', divider: 'a `Stack class("border-t")`', hr: 'a `Stack class("border-t")`', spacer: 'a `gap-*` class on the parent `Stack`',
  spinner: 'an `Icon "lucide:loader-2" class("animate-spin")`', loader: 'an `Icon "lucide:loader-2" class("animate-spin")`', tag: 'a `Span "…" class("badge")`',
};
export function nonPrimitiveHint(name: string): string { return NON_PRIMITIVES[String(name || '').toLowerCase()] || ''; }

/** Compile output format. */
export enum Fmt { Module = 'module', Store = 'store', Html = 'html', Ssr = 'ssr', Patch = 'patch', Native = 'native' }   // native: a React Native screen (engine/native/)

/** Editable form-field kinds (how a Form renders an entity field). */
export enum Fk { Text = 'text', Email = 'email', Number = 'number', Bool = 'bool', Enum = 'enum', Date = 'date', Password = 'password', Textarea = 'textarea' }

/** Binary operators (in the expression AST). */
export enum BOp {
  Or = 'or', And = 'and',
  Eq = '==', Neq = '!=', Lte = '<=', Gte = '>=', Lt = '<', Gt = '>', Contains = 'contains',
  Add = '+', Sub = '-', Mul = '*', Div = '/',
}
/** Unary operators. */
export enum UOp { Not = 'not' }

/** Expression AST node kinds (discriminants). */
export enum Ek { Lit = 'lit', Ref = 'ref', Un = 'un', Bin = 'bin', Tern = 'tern', Interp = 'interp', Call = 'call', Obj = 'obj', Agg = 'agg', Filter = 'filter', Arr = 'arr', List = 'list' }

// List aggregates: `list.sum by expr` (projection) / `list.count where cond` (predicate).
// Item-implicit (fields read bare, like a `where` filter); `.length` stays the count-all.
export const AGG_OPS = new Set<string>(['sum', 'count', 'avg', 'min', 'max']);
// List sort: `contacts.sort by name` (asc) / `scores.sortDesc by points` (desc).
// Same item-implicit `by` projection (reuses AggExpr), but returns a list, not a scalar.
export const SORT_OPS = new Set<string>(['sort', 'sortDesc']);
/** An entity enum field's type in the IR: `enum:today|tomorrow` (written `today | tomorrow`). */
export const ENUM_PREFIX = 'enum:';
/** `list.take(n)`: the first n items, same element type. */
export const TAKE_OP = 'take';
/** A query's rows: `items.data` (the query itself also holds `.loading` / `.error`). */
export const QUERY_DATA = 'data';

/** Action-body statement ops (discriminants): mutations + the `if` branch. */
export enum StOp { Push = 'push', Set = 'set', Reset = 'reset', Toggle = 'toggle', Remove = 'remove', Patch = 'patch', Create = 'create', Update = 'update', Delete = 'delete', Refetch = 'refetch', Send = 'send', Request = 'request', Call = 'call', Extern = 'extern', If = 'if' }

/** The attribute prefix data(...) keys carry once parsed (they share aria's map). */
export const DATA_PREFIX = 'data-';
/** DOM properties that hold a URL: built from data, they pass through the runtime's __safeUrl (no `javascript:` links). */
export const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'poster']);
/** The class of the Stack that wraps a part with several roots (`part P() { when a {…} when b {…} }`), so CSS can name
 *  that wrapper by class. Matching it by `[class="mu-stack"]` instead made Chrome restyle a whole subtree on every class
 *  change anywhere in the page (an attribute test on an ancestor followed by `> *`). */
export const PART_WRAP_CLASS = 'mu-part';
/** Node modifiers (post-primitive). */
export enum Mod {
  Bind = 'bind', Checked = 'checked', Submit = 'submit', Where = 'where', Columns = 'columns',
  Class = 'class', Alt = 'alt', Inputs = 'inputs', On = 'on', Aria = 'aria', Style = 'style', Disabled = 'disabled', Options = 'options',
  Data = 'data',   // data(slot: "card", state: open) — `data-*` attributes for CSS hooks (component libraries style by them); rides aria()'s machinery
  Group = 'group',   // Details group("faq") — siblings sharing a group open one at a time (native <details name>)
  Eager = 'eager',   // Image eager — load it now (the cover, the first thing seen); every other Image loads as it nears the screen
  Lazy = 'lazy',     // Custom X lazy — mount it (and whatever its mount imports) only as its place nears the screen
  Wake = 'wake',     // an island's wake: `wake load | idle | visible | media "(…)"` (runtime-island.ts)
  Accept = 'accept',
  Currency = 'currency',   // Number currency("COP") — a money field: grouped as the page's language writes it, decimals only if the currency has them   // File accept("image/*") — what the picker offers and what a drop takes
  Id = 'id',   // id("features") — a stable DOM id; the target an in-page `Link -> "#features"` anchor scrolls to
  Min = 'min', Max = 'max', Step = 'step',   // Number/Range numeric bounds + step (each takes one number expression)
  Draggable = 'draggable', Droptarget = 'droptarget',   // drag pack: mark an element draggable (carries an id) + a drop zone (fires on(drop: action(id, group)))
  Kind = 'kind', Color = 'color',   // Chart encodings: kind(bar|line|area|point) + color(field)
  // geometry: x/y are shared (Chart encodings read them as field refs; SVG marks as coordinate expressions).
  X = 'x', Y = 'y', W = 'w', H = 'h', Cx = 'cx', Cy = 'cy', R = 'r', X1 = 'x1', Y1 = 'y1', X2 = 'x2', Y2 = 'y2', Rx = 'rx',
  Start = 'start', End = 'end', Inner = 'inner',   // Arc: sweep start→end degrees (0=top, clockwise), inner radius (0=pie, >0=donut)
  ViewBox = 'viewBox', D = 'd', Transform = 'transform',
}
/** Chart mark kinds — the bounded grammar-of-graphics vocabulary. */
export const CHART_KINDS = new Set<string>(['bar', 'line', 'area', 'point', 'scatter', 'pie', 'donut']);
/** The native vector primitives — marks live inside an `Svg` (or a `Group`). */
export const SVG_PRIMS = new Set<string>([Nt.Svg, Nt.Rect, Nt.Line, Nt.Circle, Nt.Path, Nt.Group, Nt.Arc]);

/** A Custom whose file has its own imports is not inlined: its `components` entry is this prefix + the file's path, and
 *  the page imports `mount` from it (the bundler resolves its npm imports). */
export const CUSTOM_MODULE = '\u0000module:';
/** A built-in function's name in the compiled code (`date(x)` → `__b_date(x)`): the page's own `date` state, a `get date(…)` or a
 *  `use date from …` can then never collide with it, and a new built-in never takes a name an app already uses. */
export const BUILTIN_PREFIX = '__b_';

/** theme.muten: the words inside `theme [library] { … }` that are not tokens, and where their values are kept. */
export const THEME_PRESET = 'preset';
export const THEME_WITH = 'with';
export const THEME_MODE = 'mode';
export const THEME_TOKENS = 'tokens';     // section holding tokens written by their own name (`primary "#…"` → --primary)
export const THEME_LIBRARY = 'library';   // section holding the library's name, preset and extras (not CSS)

/** The keyboard skip link the shell carries, in the page's language (`<html lang>`): it is the framework's own words. */
export const SKIP_LINK_TEXT: { readonly [lang: string]: string } = {
  en: 'Skip to content', es: 'Saltar al contenido', pt: 'Pular para o conteúdo', fr: 'Aller au contenu', it: 'Vai al contenuto', de: 'Zum Inhalt springen',
};

/** `device`: the browser as a store every page can read (runtime-device.ts); an app's own device.store wins. */
export const DEVICE_STORE = 'device';
export const DEVICE_MEMBERS: readonly string[] = ['online', 'dark', 'reducedMotion', 'touch', 'width', 'height', 'visible', 'lang', 'now', 'scrollY', 'scrollDir'];

/** `lang`: the language the app speaks, a store every page can read once the app has src/lang/*.lang (runtime-lang.ts). */
/** `theme.colors.primary`: theme.muten's values, read from a page (style/theme-ref.ts). */
export const THEME_REF = 'theme';
/** `provider ThemeProvider(theme: …) from "@mui/material"` in theme.muten: wraps every component of that library. */
export const THEME_PROVIDER = 'provider';
/** `new mapboxgl.Map({ … })`: a class a package exports, made as its docs show. */
export const NEW = 'new';
/** Inside a `live <feed>`, the callback muten hands the package: each change it gets is applied to the state. */
export const LIVE_CHANGE = 'change';
/** `url.s` · `url.set({ s: "pagos" })`: the address bar as a builtin store (runtime-url.ts). */
export const URL_STORE = 'url';
/** `use google from script "https://…"`: a library loaded by its own <script> tag, read off the page as a global. */
export const FROM_SCRIPT = 'script';
/** What a `file` state tells about the file picked: `photo.name`, `photo.size` (bytes), `photo.type`. */
export const FILE_MEMBERS: readonly string[] = ['name', 'size', 'type'];
export const LANG_STORE = 'lang';
export const LANG_MEMBERS: readonly string[] = ['current', 'list'];
export const LANG_USE = 'use';            // `lang.use("en")`
/** `t("key", …)`: a text of the app's src/lang/*.lang, in the page's language (a `use t` of the app's own wins). */
export const TRANSLATE = 't';

/** The words of a `.test` file (`muten test`): a test is steps a person would take, found the way a person finds them. */
export enum TestKw {
  Test = 'test',
  Open = 'open',     // open "/route"
  Press = 'press',   // press "Add": a button, link or other control by its text or label
  Fill = 'fill',     // fill "Email" with "ana@x.co": a field by its label, placeholder or name
  With = 'with',
  See = 'see',       // see "Total: $10" / see no "Error": the visible text, retried until it holds
  No = 'no',
  Wait = 'wait',     // wait 300: milliseconds
}
/** A host component's file in src/components/, by the extensions it may have: TypeScript first (`Map.ts`, its mount's
 *  types checked at each call), then JavaScript. */
export const HOST_EXTS: ReadonlyArray<string> = ['.ts', '.js'];
/** When an island wakes (loads its library and draws): as the page opens, once the browser is idle, as its place nears
 *  the screen (the default), or while a media query holds. Astro's `client:load|idle|visible|media`. */
export enum WakeMode { Load = 'load', Idle = 'idle', Visible = 'visible', Media = 'media' }
/** Touch gestures `on(…)` listens for on any element (runtime-gesture.ts); `pinch` hands its action the scale. */
export const GESTURES: ReadonlySet<string> = new Set(['swipe-left', 'swipe-right', 'swipe-up', 'swipe-down', 'long-press', 'double-tap', 'pinch']);
/** The extension of a test file, next to its page (`home.muten` + `home.test`). */
export const TEST_EXT = '.test';

/** What a `use` brings in: functions (the default), or a UI component from npm used like a part.
 *  `use element Rating "sl-rating" from "…"` (a Web Component) · `use widget Map from "…"` (exports `mount(el, inputs, on)`)
 *  · `use react DayPicker from "…"` (a React component, mounted as an island) · `use vue` / `use svelte` / `use solid`
 *  (a compiled component of that framework, an island too: framework-island.ts). */
export enum UseKind { Element = 'element', Widget = 'widget', React = 'react', Vue = 'vue', Svelte = 'svelte', Solid = 'solid' }
