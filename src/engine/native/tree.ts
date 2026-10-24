// tree: a page's nodes as React Native JSX. The page's logic (state, gets, actions, expressions) is compiled by the
// same Logic the web output uses; only the drawing differs. Anything that reads a signal is wrapped in <R render={…}>,
// the native kit's fine-grained piece (native-kit/native.jsx): its JSX is a muten `computed`, so React redraws that
// piece alone, and only when what it read has changed. A list is a keyed map inside its own <R>; a `when` is an <R>
// that draws its children or nothing. What the native output does not draw is a visible placeholder and a gap.
//
// A node's style is its base style plus every conditional style while its condition holds (styles.ts): a muten
// condition, the kit's live screen (@media), the row's index (`__i_<each>`, `__rows_<each>`), a press (`pressed`,
// Pressable's own) or a focus (`focused`, the kit's Field). A grid's cells get their width from the kit's Grid.
import { Nt } from '#engine/shared/vocab.js';
import type { Doc, Expr, FlatNode, Interp, NodeProps, Scope, StringPropValue } from '#engine/shared/types.js';
import type { NativeGap, NodeLook, RnConditional, RnStyle } from '#engine/shared/types-native.js';
import type { Logic } from '#engine/compile/logic.js';
import { PRIMITIVES } from '#engine/native/coverage.js';
import { iconNames } from '#engine/ir/icon-names.js';

const BOXES = new Set<string>([Nt.Stack, Nt.Section, Nt.Header, Nt.Footer, Nt.Nav, Nt.Article, Nt.Sidebar, Nt.List, Nt.Row, Nt.Cell, Nt.Details, Nt.Shell]);
const FIELDS = new Set<string>([Nt.SearchField, Nt.Password, Nt.Textarea, Nt.Number]);
const TRANSPARENT = new Set<string>([Nt.Each, Nt.When, Nt.Slot]);
const PRESSED = /\bpressed\b/, FOCUSED = /\bfocused\b/;
const MOTION = /^(animation|transition)/;
const WHOLE_VAR = /^var\(\s*--([\w-]+)\s*(?:,\s*(.+))?\)$/;

/** The JSX of a page, the StyleSheet entries it refers to, and what it could not draw. */
export interface NativeTree { jsx: string; styles: { [name: string]: RnStyle }; gaps: NativeGap[]; nodes: number; drawn: number }

/** A node's style as code, whether it reads anything while the app runs, and whether it follows a press or a focus. */
interface StyleCode { code: string; live: boolean; pressed: boolean; focused: boolean; moves?: boolean }

export function nativeTree(doc: Doc, logic: Logic, looks: Map<string, NodeLook>, iconSvg?: (ref: string) => string): NativeTree {
  const out: NativeTree = { jsx: 'null', styles: {}, gaps: [], nodes: 0, drawn: 0 };
  const parent = new Map<string, string>();
  for (const [id, item] of Object.entries(doc.nodes)) for (const kid of item.children || []) parent.set(kid, id);
  const boxParent = (id: string): string | undefined => { let at = parent.get(id); while (at && TRANSPARENT.has(doc.nodes[at].type)) at = parent.get(at); return at; };
  const expr = (value: Expr, scope: Scope): string => logic.compileExpr(value, scope);

  const styleRef = (id: string, which: 'style' | 'text'): string => {
    const value = looks.get(id)?.[which];
    if (!value || !Object.keys(value).length) return 'undefined';
    const name = which === 'style' ? `n${id}` : `t${id}`;
    out.styles[name] = value;
    return `S.${name}`;
  };
  const condition = (entry: RnConditional, scope: Scope): string => [entry.cond ? `(${expr(entry.cond, scope)})` : '', entry.js ? `(${entry.js})` : ''].filter(Boolean).join(' && ') || 'true';
  // a node's box style (or its label's text style): base, conditional styles on top, and run-time variables last
  const layered = (id: string, which: 'style' | 'text', scope: Scope): StyleCode => {
    const base = styleRef(id, which);
    const prefix = which === 'style' ? 'n' : 't';
    const look = looks.get(id);
    const parts = [base];
    let live = false, pressed = false, focused = false;
    (look?.conditional || []).forEach((entry, index) => {
      if (!Object.keys(entry[which]).length) return;
      out.styles[`${prefix}${id}c${index}`] = entry[which];
      const test = condition(entry, scope);
      parts.push(`(${test}) && S.${prefix}${id}c${index}`);
      live = true; pressed ||= PRESSED.test(test); focused ||= FOCUSED.test(test);
    });
    if (which === 'style' && look?.live.length) { const dynamic = liveStyle(id, look, scope); if (dynamic) { parts.push(dynamic); live = true; } }
    return { code: parts.length === 1 ? base : `[${parts.join(', ')}]`, live, pressed, focused, moves: which === 'style' && moves(id) };
  };
  // `width: var(--w)` where the page sets --w (`style(w: "{pct}%")` on the node or a box above it): the kit turns the
  // value into a style while the app runs
  const liveStyle = (id: string, look: NodeLook, scope: Scope): string | null => {
    const entries: string[] = [];
    for (const { prop, value } of look.live) {
      const match = WHOLE_VAR.exec(value.trim());
      let source: string | undefined = id;
      while (match && source && doc.nodes[source].props?.styleVars?.[match[1]] === undefined) source = parent.get(source);
      const set = match && source ? doc.nodes[source].props?.styleVars?.[match[1]] : undefined;
      if (match && set === undefined && match[2]) { entries.push(`${JSON.stringify(prop)}: ${JSON.stringify(match[2])}`); continue; }   // nobody above sets it: the CSS fallback
      if (!match || set === undefined) { out.gaps.push({ kind: 'value', what: `${prop}: ${value}`, why: 'a run-time variable is read as the whole value (`width: var(--w)`), set by style() on the node or a box above it', level: 'none' }); continue; }
      const read = text(set, scope).code;
      entries.push(`${JSON.stringify(prop)}: ${match[2] ? `(${read}) || ${JSON.stringify(match[2])}` : read}`);
    }
    return entries.length ? `liveStyle({ ${entries.join(', ')} })` : null;
  };
  // a text prop as a JS string expression, and whether it reads anything at run time
  const text = (value: StringPropValue | undefined, scope: Scope): { code: string; live: boolean } => {
    if (value === undefined) return { code: '""', live: false };
    if (typeof value === 'string') return { code: JSON.stringify(value), live: false };
    if ('$param' in value) return { code: logic.resolveRef(value.$param, scope), live: true };
    const interp: Interp = value;
    return { code: interp.parts.map((part) => (typeof part === 'string' ? JSON.stringify(part) : `String(${expr(part, scope)} ?? '')`)).join(' + '), live: interp.parts.some((part) => typeof part !== 'string') };
  };
  // a node that moves (an animation, a transition, in its style or a conditional one) is drawn by Reanimated
  const moves = (id: string): boolean => {
    const look = looks.get(id);
    return !!look && [look.style, ...look.conditional.map((entry) => entry.style)].some((style) => Object.keys(style).some((key) => MOTION.test(key)));
  };
  const textProps = (id: string): string => {
    const props = looks.get(id)?.textProps || {};
    return `${props.numberOfLines ? ` numberOfLines={${props.numberOfLines}}` : ''}${props.ellipsizeMode ? ` ellipsizeMode="${props.ellipsizeMode}"` : ''}`;
  };
  const live = (jsx: string, isLive: boolean): string => (isLive ? `<R render={() => (${jsx})} />` : jsx);
  const kids = (node: FlatNode, scope: Scope): string => (node.children || []).map((kid) => draw(kid, scope)).join('\n');
  const call = (p: NodeProps, scope: Scope): string => `${logic.actionRef(p.action)}(${p.arg !== undefined ? [p.arg, ...(p.argRest || [])].map((arg) => expr(arg, scope)).join(', ') : ''})`;
  const gap = (node: FlatNode, why: string): string => {
    out.gaps.push({ kind: 'primitive', what: node.type, why, level: 'none' });
    return `<Text style={{ color: '#B33F00', fontSize: 12 }}>[${node.type}: not on the phone yet]</Text>`;
  };
  // a list's rows as an expression (the each's list, filtered and cut as it draws it)
  const rowsOf = (each: FlatNode, scope: Scope): string => {
    const p = each.props || {};
    if (!p.list || !p.as) return '[]';
    const inner: Scope = { ...scope, locals: new Set([...scope.locals, p.as, ...(p.index ? [p.index] : [])]) };
    const filter = p.filter ? `.filter((${p.as}${p.index ? `, ${p.index}` : ''}) => ${expr(p.filter, inner)})` : '';
    const take = p.take ? `.slice(0, ${expr(p.take, scope)})` : '';
    return `((() => { const __l = ${expr(p.list, scope)}; return Array.isArray(__l) ? __l : []; })())${filter}${take}`;
  };
  // a grid's cell: which column it falls in. The cells before it are its fixed siblings, the rows of every list
  // before it (known on the phone: the same expression the list draws from) and what a `when` before it shows
  const cellIndex = (id: string, scope: Scope): string => {
    const container = boxParent(id);
    if (!container) return '0';
    // the grid's own child this node comes from: itself, or the list (or `when`) that draws it
    let slot = id, below = id;
    while (parent.get(slot) !== container) { below = slot; slot = parent.get(slot) || container; if (slot === container) return '0'; }
    const inList = doc.nodes[slot].type === Nt.Each ? slot : undefined;
    const inWhen = doc.nodes[slot].type === Nt.When ? slot : undefined;
    const before: string[] = [];
    for (const sibling of doc.nodes[container].children || []) {
      if (sibling === slot) break;
      const item = doc.nodes[sibling];
      if (item.type === Nt.Each) before.push(`${rowsOf(item, scope)}.length * ${(item.children || []).length}`);
      else if (item.type === Nt.When && item.props?.cond) before.push(`((${expr(item.props.cond, scope)}) ? ${(item.children || []).length} : 0)`);
      else before.push('1');
    }
    const roots = doc.nodes[slot].children || [];
    const own = inList ? `__i_${inList} * ${roots.length} + ${roots.indexOf(below)}` : inWhen ? String(roots.indexOf(below)) : '0';
    return [...before, own].join(' + ');
  };
  // a list or a `when` takes no cell of its own: what it draws does
  const inCell = (id: string, jsx: string, scope: Scope): string => {
    const container = boxParent(id);
    if (TRANSPARENT.has(doc.nodes[id].type) || !container || !looks.get(container)?.grid) return jsx;
    return `<Cell index={${cellIndex(id, scope)}}>\n${jsx}\n</Cell>`;
  };
  // a Pressable's style and label follow its press (`:active`) only when the CSS asks for it
  const pressable = (role: string, box: StyleCode, label: StyleCode, content: string, rest: string): string => {
    const style = box.pressed ? `({ pressed }) => (${box.code})` : box.code;
    const inner = label.pressed ? `{({ pressed }) => (${content})}` : content;
    const tag = box.moves ? 'AnimatedPressable' : 'Pressable';
    return `<${tag} accessibilityRole="${role}" style={${style}}${rest}>\n${inner}\n</${tag}>`;
  };

  function draw(id: string, scope: Scope): string {
    return inCell(id, drawNode(id, scope), scope);
  }

  function drawNode(id: string, scope: Scope): string {
    const node = doc.nodes[id];
    const p = node.props || {};
    const look = looks.get(id);
    out.nodes++;
    for (const event of Object.keys(p.on || {})) out.gaps.push({ kind: 'feature', what: `on(${event})`, why: 'events and gestures are not on the phone yet', level: 'none' });
    const drawn = (jsx: string): string => { out.drawn++; return jsx; };
    // a page starts below the status bar and ends above the gesture bar (the safe area), painted with the page's own color.
    // A tap on a button while the keyboard is open reaches the button, as on the web (React Native would spend it
    // closing the keyboard: «Guardar» needed two taps)
    if (node.type === Nt.Page) {
      const box = layered(id, 'style', scope);
      // a page that moves in (`.mu-page { animation: … }`): its content is an Animated.View with the page's style
      const inner = moves(id) ? `<ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1 }}>\n<Animated.View style={${box.code}}>\n${kids(node, scope)}\n</Animated.View>\n</ScrollView>` : `<ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={${box.code}}>\n${kids(node, scope)}\n</ScrollView>`;
      return drawn(live(`<SafeAreaView style={{ flex: 1, backgroundColor: StyleSheet.flatten(${box.code})?.backgroundColor }}>\n${inner}\n</SafeAreaView>`, box.live));
    }
    if (BOXES.has(node.type)) {
      const box = layered(id, 'style', scope);
      if (look?.grid) return drawn(live(`<Grid plan={${JSON.stringify(look.grid)}} style={${box.code}}>\n${kids(node, scope)}\n</Grid>`, box.live));
      const view = moves(id) ? 'Animated.View' : 'View';
      return drawn(live(`<${view} style={${box.code}}>\n${kids(node, scope)}\n</${view}>`, box.live));
    }
    if (node.type === Nt.Text || node.type === Nt.Title || node.type === Nt.Span) {
      const box = layered(id, 'style', scope); const value = text(p.value, scope);
      const inner = node.children?.length ? `{${value.code}}${kids(node, scope)}` : `{${value.code}}`;
      const [view, txt] = moves(id) ? ['Animated.View', 'Animated.Text'] : ['View', 'Text'];
      if (look?.boxed) { const label = layered(id, 'text', scope); return drawn(live(`<${view} style={${box.code}}><Text style={${label.code}}${textProps(id)}>${inner}</Text></${view}>`, box.live || label.live || value.live)); }
      return drawn(live(`<${txt} style={${box.code}}${textProps(id)}>${inner}</${txt}>`, box.live || value.live));
    }
    if (node.type === Nt.Button) {
      const box = layered(id, 'style', scope); const label = text(p.label, scope); const labelStyle = layered(id, 'text', scope);
      const disabled = p.disabled ? ` disabled={!!(${expr(p.disabled, scope)})}` : '';
      const content = node.children?.length ? kids(node, scope) : `<Text style={${labelStyle.code}}>{${label.code}}</Text>`;
      return drawn(live(pressable('button', box, labelStyle, content, `${disabled} onPress={() => ${p.action ? call(p, scope) : 'undefined'}}`), box.live || label.live || labelStyle.live || !!p.disabled));
    }
    if (node.type === Nt.Link) {
      const box = layered(id, 'style', scope); const label = text(p.label, scope); const to = text(p.to ?? '/', scope); const labelStyle = layered(id, 'text', scope);
      const content = node.children?.length ? kids(node, scope) : `<Text style={${labelStyle.code}}>{${label.code}}</Text>`;
      return drawn(live(pressable('link', box, labelStyle, content, ` onPress={() => go(${to.code})}`), box.live || label.live || to.live || labelStyle.live));
    }
    if (FIELDS.has(node.type) && p.bind) {
      const box = layered(id, 'style', scope); const hint = text(p.placeholder ?? p.label, scope); const label = styleRef(id, 'text');
      const extra = node.type === Nt.Password ? ' secureTextEntry' : node.type === Nt.Textarea ? ' multiline' : node.type === Nt.Number ? ' keyboardType="numeric"' : '';
      // a Number field holds a number: what is typed is read as one (empty stays empty)
      const typed = node.type === Nt.Number ? `(__t === '' ? __t : Number(__t))` : '__t';
      const style = box.focused ? `(focused) => [${box.code}, ${label}]` : `[${box.code}, ${label}]`;
      const placeholder = look?.placeholderColor ? ` placeholderTextColor=${JSON.stringify(look.placeholderColor)}` : '';
      return drawn(live(`<Field style={${style}} placeholder={${hint.code}}${placeholder}${extra} read={() => ${logic.bindRead(p.bind, scope)}} write={(__t) => { const __v = ${typed}; ${logic.bindWrite(p.bind, scope, '__v')} }} />`, box.live));
    }
    if (node.type === Nt.Checkbox) {
      const box = layered(id, 'style', scope); const label = text(p.label, scope);
      const read = p.bind ? logic.bindRead(p.bind, scope) : p.checked ? expr(p.checked, scope) : 'false';
      const write = p.action ? `() => ${call(p, scope)}` : p.bind ? `(__v) => { ${logic.bindWrite(p.bind, scope, '__v')} }` : '() => {}';
      return drawn(`<Check style={${box.code}} labelStyle={${styleRef(id, 'text')}} label={${label.code}} read={() => ${read}} write={${write}} />`);
    }
    if (node.type === Nt.Image) {
      const box = layered(id, 'style', scope); const src = text(p.src, scope); const alt = text(p.alt, scope);
      // a fixed path into public/ is packed with the app (require); anything else is an address, loaded at run time
      const local = typeof p.src === 'string' && p.src.startsWith('/') && !p.src.startsWith('//');
      const source = local ? `require('../public${p.src}')` : `{ uri: ${src.code} }`;
      return drawn(live(`<Image style={${box.code}} source={${source}} accessibilityLabel={${alt.code}} contentFit="${look?.fit ?? 'cover'}" />`, box.live || src.live));
    }
    if (node.type === Nt.Each && p.list && p.as) {
      // the row's index and the list's length carry the each's id: :first-child, :nth-child and a grid's cells read them
      const index = `__i_${id}`, rows = `__rows_${id}`;
      const inner: Scope = { ...scope, locals: new Set([...scope.locals, p.as, ...(p.index ? [p.index] : [])]) };
      const alias = p.index ? `const ${p.index} = ${index}; ` : '';
      return drawn(`<R render={() => { const ${rows} = ${rowsOf(node, scope)}; return (<>{${rows}.map((${p.as}, ${index}) => { ${alias}return (<React.Fragment key={${p.as} && ${p.as}.id != null ? ${p.as}.id : ${index}}>\n${kids(node, inner)}\n</React.Fragment>); })}</>); }} />`);
    }
    // an icon: the same SVG the web shows (resolved from its Iconify set while compiling), drawn by react-native-svg; as
    // big as the CSS makes it, else 1em (the inherited font size), in the inherited color (currentColor)
    if (node.type === Nt.Icon && iconSvg) {
      const box = layered(id, 'style', scope);
      const style = look?.style || {}, ink = look?.text || {};
      const size = typeof style.width === 'number' ? style.width : typeof style.height === 'number' ? style.height : typeof ink.fontSize === 'number' ? ink.fontSize : 16;
      const color = typeof style.color === 'string' ? style.color : typeof ink.color === 'string' ? ink.color : '#000';
      const svgOf = (ref: string): string => { try { return iconSvg(ref); } catch (error) { out.gaps.push({ kind: 'value', what: `Icon "${ref}"`, why: error instanceof Error ? error.message : String(error), level: 'none' }); return ''; } };
      if (p.name && typeof p.name === 'object' && 'parts' in p.name) {   // `Icon "{tab.icon}"`: the names it can take ship, the one it is shows
        const svgs = Object.fromEntries((iconNames(p.name, doc) || []).map((ref) => [ref, svgOf(ref)]));
        return drawn(`<R render={() => { const __svg = ${JSON.stringify(svgs)}[${text(p.name, scope).code}]; return __svg ? <SvgXml xml={__svg} width={${size}} height={${size}} color={${JSON.stringify(color)}} style={${box.code}} /> : null; }} />`);
      }
      const svg = svgOf(typeof p.name === 'string' ? p.name : '');
      return svg ? drawn(live(`<SvgXml xml={${JSON.stringify(svg)}} width={${size}} height={${size}} color={${JSON.stringify(color)}} style={${box.code}} />`, box.live)) : gap(node, `the icon "${String(p.name)}" did not resolve`);
    }
    // the shell's slot: where every route shows, expo-router's navigator (going back and the route stack keep working)
    if (node.type === Nt.Slot) return drawn('<View style={{ flex: 1 }}><Stack screenOptions={{ headerShown: false }} /></View>');
    if (node.type === Nt.When && p.cond) return drawn(`<R render={() => ((${expr(p.cond, scope)}) ? (<>\n${kids(node, scope)}\n</>) : null)} />`);
    return gap(node, PRIMITIVES[node.type]?.note ?? 'not in the native coverage table');
  }

  out.jsx = doc.rootId ? draw(doc.rootId, { locals: new Set() }) : 'null';
  return out;
}
