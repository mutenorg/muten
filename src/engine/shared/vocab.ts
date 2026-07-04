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
  Get = 'get', Effect = 'effect', Action = 'action', Mutates = 'mutates',
  Mock = 'mock', Sources = 'sources', Routes = 'routes', Shell = 'shell',
  Part = 'part', Const = 'const', Theme = 'theme', Query = 'query', Every = 'every', Live = 'live', Persist = 'persist', Param = 'param', Api = 'api', Body = 'body', Into = 'into', Meta = 'meta',
  Use = 'use', From = 'from',
  When = 'when', Each = 'each', Match = 'match', As = 'as', Where = 'where', By = 'by', With = 'with', If = 'if', Else = 'else', Ordered = 'ordered', Open = 'open',
  Guard = 'guard', Not = 'not', And = 'and', Or = 'or', Contains = 'contains',
  Required = 'required', Min = 'min', Max = 'max', Pattern = 'pattern',
  True = 'true', False = 'false', Null = 'null',
}

/** Primitive / node type names (the full vocabulary the parser builds and the compiler emits). */
export enum Nt {
  // containers (semantic landmarks + layout)
  Shell = 'Shell', Header = 'Header', Nav = 'Nav', Sidebar = 'Sidebar', Footer = 'Footer', Page = 'Page', Stack = 'Stack',
  Section = 'Section', Article = 'Article', List = 'List', Details = 'Details',
  // content
  Text = 'Text', Title = 'Title', Span = 'Span', Image = 'Image', Icon = 'Icon', Video = 'Video',
  // interactive
  Link = 'Link', Button = 'Button', Form = 'Form', SearchField = 'SearchField',
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

/** Compile output format. */
export enum Fmt { Module = 'module', Store = 'store', Html = 'html', Ssr = 'ssr', Patch = 'patch' }

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
export enum Ek { Lit = 'lit', Ref = 'ref', Un = 'un', Bin = 'bin', Tern = 'tern', Interp = 'interp', Call = 'call', Obj = 'obj', Agg = 'agg', Filter = 'filter' }

// List aggregates: `list.sum by expr` (projection) / `list.count where cond` (predicate).
// Item-implicit (fields read bare, like a `where` filter); `.length` stays the count-all.
export const AGG_OPS = new Set<string>(['sum', 'count', 'avg', 'min', 'max']);
// List sort: `contacts.sort by name` (asc) / `scores.sortDesc by points` (desc).
// Same item-implicit `by` projection (reuses AggExpr), but returns a list, not a scalar.
export const SORT_OPS = new Set<string>(['sort', 'sortDesc']);

/** Action-body statement ops (discriminants): mutations + the `if` branch. */
export enum StOp { Push = 'push', Set = 'set', Reset = 'reset', Toggle = 'toggle', Remove = 'remove', Patch = 'patch', Create = 'create', Update = 'update', Delete = 'delete', Refetch = 'refetch', Request = 'request', Call = 'call', Extern = 'extern', If = 'if' }

/** Node modifiers (post-primitive). */
export enum Mod {
  Bind = 'bind', Submit = 'submit', Where = 'where', Columns = 'columns',
  Class = 'class', Alt = 'alt', Inputs = 'inputs', On = 'on', Aria = 'aria', Style = 'style', Disabled = 'disabled', Options = 'options',
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
/** SVG geometry attributes that take a numeric EXPRESSION (reactive). x/y are shared with Chart encodings. */
export const SVG_GEO: readonly string[] = ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'rx', 'start', 'end', 'inner'];
/** The native vector primitives — marks live inside an `Svg` (or a `Group`). */
export const SVG_PRIMS = new Set<string>([Nt.Svg, Nt.Rect, Nt.Line, Nt.Circle, Nt.Path, Nt.Group, Nt.Arc]);
/** SVG geometry attr -> the real SVG attribute name (w/h are shorthands). */
export const SVG_ATTR: { readonly [k: string]: string } = { x: 'x', y: 'y', w: 'width', h: 'height', cx: 'cx', cy: 'cy', r: 'r', x1: 'x1', y1: 'y1', x2: 'x2', y2: 'y2', rx: 'rx' };
