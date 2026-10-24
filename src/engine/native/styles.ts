// styles: each node's React Native style, decided at compile time from the app's CSS and the page's tree. React Native
// has no selectors and no cascade; muten knows the whole tree, so it does the matching itself. A rule that matches a
// node either always does (its style is the node's base style) or does under conditions it brings along:
//   · a class toggled by a muten condition (`class("on" when open)`), on the node or on an ancestor;
//   · a state: `disabled when …` (:disabled), a press (:active), a focus (:focus);
//   · a place: :first-child / :nth-child of a node repeated by `each` (the row's index, on the phone);
//   · an @media condition (the window's size, dark mode), live on the phone.
// Conditional rules become styles that switch on and off by themselves. Rules apply by specificity and order as in
// CSS, and what CSS inherits (color, font, line height, white-space…) is passed down by hand, conditions included:
// `.chip.on { color: #fff }` reaches the chip's label.
import { Nt, Ek, BOp } from '#engine/shared/vocab.js';
import type { Doc, Expr, FlatNode } from '#engine/shared/types.js';
import type { CssRule, CssSheet, NativeGap, NodeLook, RnConditional, RnStyle, TextProps } from '#engine/shared/types-native.js';
import { translate } from '#engine/native/profile.js';
import { liveVars } from '#engine/native/css.js';
import { parseSelector, picks, TAG_OF, ICON_TAGS, STATE_DISABLED, STATE_ACTIVE, STATE_FOCUS } from '#engine/native/selectors.js';
import type { Compound, Nth, Selector } from '#engine/native/selectors.js';
import { mediaCondition } from '#engine/native/media.js';
import { gridPlan } from '#engine/native/grid.js';
import { EM } from '#engine/native/units.js';
import { KEYFRAMES, keyframesOf } from '#engine/native/motion.js';

// what CSS passes from a box to the text inside it
const INHERITED = ['color', 'fontSize', 'fontWeight', 'fontStyle', 'fontFamily', 'letterSpacing', 'textAlign', 'textTransform', '__lineHeightFactor', 'lineHeight', 'fontVariant', '__nowrap'];
const TEXT_ONLY = new Set([...INHERITED, 'textDecorationLine', 'textDecorationColor', 'textDecorationStyle', 'verticalAlign', 'textShadowOffset', 'textShadowRadius', 'textShadowColor', '__ellipsis', '__lines']);
// nodes that draw text: they take the inherited text style; boxes drop it
export const TEXT_NODES: ReadonlySet<string> = new Set([Nt.Text, Nt.Title, Nt.Span]);
// nodes with no box of their own: transparent for selectors (a rule sees through them to the real parent)
const TRANSPARENT = new Set<string>([Nt.Each, Nt.When, Nt.Slot]);
const PRESSABLE = new Set<string>([Nt.Button, Nt.Link]);
const FIELDS = new Set<string>([Nt.SearchField, Nt.Password, Nt.Textarea, Nt.Number]);
// the browser's own look for a heading, which an app's CSS builds on
const HEADING: { readonly [level: string]: RnStyle } = { h1: { fontSize: 32, fontWeight: '700' }, h2: { fontSize: 24, fontWeight: '700' }, h3: { fontSize: 19, fontWeight: '700' }, h4: { fontSize: 16, fontWeight: '700' }, h5: { fontSize: 13, fontWeight: '700' }, h6: { fontSize: 11, fontWeight: '700' } };
const BASE_FONT = 16;
const UNLAYERED = 1000;   // above every cascade layer
const MARKERS = ['__grid', '__columns', '__lines', '__nowrap', '__ellipsis', '__fit', '__webkitBox'];

/** What a rule needs to hold for a node: muten conditions (all of them) and kit conditions (JavaScript). */
interface Need { exprs: Expr[]; js: string[] }
interface Hit { rule: CssRule; selector: Selector; need: Need; rank: number }
interface Heritage { base: RnStyle; conditional: RnConditional[] }

const and = (exprs: Expr[]): Expr | undefined => exprs.reduce<Expr | undefined>((left, right) => (left ? { kind: Ek.Bin, op: BOp.And, left, right } : right), undefined);
const nthJs = (rule: Nth, position: string): string => (rule.a === 0 ? `(${position}) === ${rule.b}` : `((${position}) - ${rule.b}) % ${rule.a} === 0 && ((${position}) - ${rule.b}) / ${rule.a} >= 0`);

/** Each node's look, and every gap the page's CSS has for the native output. */
export function nativeLooks(doc: Doc, sheet: CssSheet): { looks: Map<string, NodeLook>; gaps: NativeGap[] } {
  const gaps: NativeGap[] = [];
  const parent = new Map<string, string>();
  for (const [id, item] of Object.entries(doc.nodes)) for (const kid of item.children || []) parent.set(kid, id);
  const boxParent = (id: string): string | undefined => { let at = parent.get(id); while (at && TRANSPARENT.has(doc.nodes[at].type)) at = parent.get(at); return at; };
  const node = (id: string): FlatNode => doc.nodes[id];
  const staticClasses = new Map(Object.keys(doc.nodes).map((id) => [id, classesOf(node(id))]));
  const toggles = (id: string): Array<{ names: string[]; cond: Expr }> => (node(id).props?.class || []).flatMap((entry) => (typeof entry !== 'string' && 'name' in entry ? [{ names: entry.name.split(/\s+/), cond: entry.cond }] : []));
  const tagsOf = (id: string): string[] => {
    const own = node(id).type === Nt.Title ? [node(id).props?.level || 'h1'] : node(id).type === Nt.Icon ? ICON_TAGS : [TAG_OF[node(id).type]];
    const up = boxParent(id);
    return [...own, ...(up && node(up).type === Nt.List ? ['li'] : [])].filter(Boolean);
  };
  // the variables the page sets while it runs (`style(w: "{pct}%")` sets --w): a rule that reads one is drawn live
  const pageVars = new Set(Object.values(doc.nodes).flatMap((item) => Object.keys(item.props?.styleVars || {}).map((name) => `--${name}`)));
  const used = new Set([...staticClasses.values()].flat());
  for (const id of Object.keys(doc.nodes)) for (const toggle of toggles(id)) for (const name of toggle.names) used.add(name);
  for (const id of Object.keys(doc.nodes)) if (node(id).props?.class?.some((entry) => typeof entry !== 'string' && !('name' in entry))) gaps.push({ kind: 'feature', what: 'class("…{x}…")', why: 'a class built from data at run time cannot be matched at compile time: toggle each class with `class("x" when …)`', level: 'none' });

  // ── a node's place among its siblings, for :first-child and friends ──
  // the box parent's children as the web lays them out: fixed nodes and at most one `each` (its rows, counted on the
  // phone by `__rows_<each>` and `__i_<each>`, which tree.ts names); a `when` among them makes the place unknown
  const place = (id: string): { position: string; fromEnd: string } | null => {
    const up = boxParent(id);
    if (!up) return { position: '1', fromEnd: '1' };
    const sequence: Array<{ id: string; roots?: string[] }> = [];
    for (const kid of node(up).children || []) {
      const type = node(kid).type;
      if (type === Nt.When || type === Nt.Slot || (type === Nt.Each && sequence.some((slot) => slot.roots))) return null;
      sequence.push(type === Nt.Each ? { id: kid, roots: node(kid).children || [] } : { id: kid });
    }
    const fixed = sequence.filter((slot) => !slot.roots).length;
    const list = sequence.findIndex((slot) => slot.roots);
    let before = 0;
    for (const [index, slot] of sequence.entries()) {
      if (slot.roots) {
        const at = slot.roots.indexOf(id);
        if (at < 0) continue;
        const start = `${before} + __i_${slot.id} * ${slot.roots.length} + ${at + 1}`;
        return { position: start, fromEnd: `${fixed} + __rows_${slot.id}.length * ${slot.roots.length} - (${start}) + 1` };
      }
      if (slot.id === id) {
        if (list >= 0 && list < index) return null;   // after a list: its position needs the list's length
        return { position: String(before + 1), fromEnd: list > index ? '' : String(fixed - before) };
      }
      before++;
    }
    return null;
  };

  // ── matching ──
  const compoundNeeds = (id: string, part: Compound, subject: boolean): Need | null => {
    const need: Need = { exprs: [], js: [] };
    if (part.tag && !tagsOf(id).includes(part.tag)) return null;
    for (const name of part.classes) {
      if (staticClasses.get(id)?.includes(name)) continue;
      const toggle = toggles(id).find((one) => one.names.includes(name));
      if (!toggle) return null;
      need.exprs.push(toggle.cond);
    }
    if (part.nths.length) {
      const where = place(id);
      if (!where) return null;
      for (const rule of part.nths) {
        const position = rule.fromEnd ? where.fromEnd : where.position;
        if (!position) return null;
        if (/^\d+$/.test(position)) { if (!picks(rule, Number(position))) return null; } else need.js.push(nthJs(rule, position));
      }
    }
    for (const state of part.states) {
      const props = node(id).props;
      if (state === STATE_DISABLED && props?.disabled) need.exprs.push(props.disabled);
      else if (state === STATE_ACTIVE && subject && PRESSABLE.has(node(id).type)) need.js.push('pressed');
      else if (state === STATE_FOCUS && subject && FIELDS.has(node(id).type)) need.js.push('focused');
      else return null;
    }
    return need;
  };
  // right to left: the node matches the last compound, then each combinator walks up the boxes
  const selectorNeeds = (id: string, selector: Selector): Need | null => {
    const first = compoundNeeds(id, selector.parts[0], true);
    if (!first) return null;
    const need: Need = { exprs: [...first.exprs], js: [...first.js] };
    let at: string | undefined = id;
    for (let index = 1; index < selector.parts.length; index++) {
      const direct = selector.combinators[index - 1] === '>';
      at = boxParent(at);
      let found: Need | null = null;
      while (at) {
        found = compoundNeeds(at, selector.parts[index], false);
        if (found || direct) break;
        at = boxParent(at);
      }
      if (!found || !at) return null;
      need.exprs.push(...found.exprs); need.js.push(...found.js);
    }
    return need;
  };

  // every selector once: the ones that translate, and a gap for each that does not but names a class the page uses
  const rules: Array<{ rule: CssRule; selector: Selector; media?: string }> = [];
  for (const rule of sheet.rules) {
    const media = rule.media ? mediaCondition(rule.media) : undefined;
    for (const text of rule.selectors) {
      const named = [...text.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
      const relevant = named.some((name) => used.has(name));
      if (media === null) { if (relevant) gaps.push({ kind: 'media', what: `@media ${rule.media}`, why: 'only width, height, orientation, color scheme, hover/pointer and reduced motion translate', level: 'none', line: rule.line }); continue; }
      const parsed = parseSelector(text);
      if (typeof parsed === 'string') { if (relevant) gaps.push({ kind: 'selector', what: text, why: parsed, level: 'none', line: rule.line }); continue; }
      if (parsed.hover) { if (relevant) gaps.push({ kind: 'selector', what: text, why: 'a touch screen has no hover: the rule never applies (use :active for the press)', level: 'approx', line: rule.line }); continue; }
      rules.push({ rule, selector: parsed, media });
    }
  }

  // ── each node's own style: base, conditional, and what is not style ──
  const ownBase = new Map<string, RnStyle>();
  const ownConditional = new Map<string, RnConditional[]>();
  const extras = new Map<string, Pick<NodeLook, 'placeholderColor' | 'live'>>();
  for (const id of Object.keys(doc.nodes)) {
    const hits: Hit[] = [];
    for (const { rule, selector, media } of rules) {
      const need = selectorNeeds(id, selector);
      if (!need) continue;
      if (media) need.js.push(media);
      // CSS's order of precedence: the layer first (none outranks all), then specificity, then the order in the sheet
      hits.push({ rule, selector, need, rank: (rule.layer ?? UNLAYERED) * 1e10 + selector.weight * 1e5 + rule.order });
    }
    hits.sort((a, b) => a.rank - b.rank);
    const base: RnStyle = {}, rankOf = new Map<string, number>();
    const extra: Pick<NodeLook, 'placeholderColor' | 'live'> = { live: [] };
    const groups = new Map<string, { need: Need; style: RnStyle }>();
    for (const hit of hits) {
      const style: RnStyle = {};
      const conditional = hit.need.exprs.length > 0 || hit.need.js.length > 0;
      for (const [name, value] of hit.rule.decls) {
        // a value that reads a variable the page sets while it runs (style(w: …)) is drawn by the tree, not here
        if (liveVars(value, sheet.vars, pageVars).length) { if (conditional) gaps.push({ kind: 'value', what: `${name}: ${value}`, why: 'a run-time variable inside a conditional rule', level: 'none', line: hit.rule.line }); else extra.live.push({ prop: name, value }); continue; }
        translate(name, value, sheet.vars, style, gaps, hit.rule.line);
      }
      if (hit.selector.placeholder) { if (typeof style.color === 'string') extra.placeholderColor = style.color; continue; }
      if (!conditional) { for (const [key, value] of Object.entries(style)) { base[key] = value; rankOf.set(key, hit.rank); } continue; }
      const key = JSON.stringify(hit.need);
      const group = groups.get(key) ?? { need: hit.need, style: {} };
      // a conditional rule loses, prop by prop, to a base rule that outranks it (as the cascade decides)
      for (const [prop, value] of Object.entries(style)) if ((rankOf.get(prop) ?? -1) < hit.rank) group.style[prop] = value;
      groups.set(key, group);
    }
    ownBase.set(id, base);
    ownConditional.set(id, [...groups.values()].map(({ need, style }) => ({ cond: and(need.exprs), js: need.js.length ? need.js.join(' && ') : undefined, style, text: {} })));
    extras.set(id, extra);
  }

  // ── inheritance: a box's text style (and its conditional text style) reaches the text inside it ──
  const inherited = new Map<string, Heritage>();
  const inheritOf = (id: string): Heritage => {
    const known = inherited.get(id);
    if (known) return known;
    const up = boxParent(id);
    const out: Heritage = { base: {}, conditional: [] };
    if (up) {
      const above = inheritOf(up), own = ownBase.get(up) || {};
      out.base = { ...above.base };
      for (const key of INHERITED) if (own[key] !== undefined) out.base[key] = own[key];
      // what the parent sets for good outranks what reached it under a condition
      out.conditional = above.conditional.map((entry) => ({ ...entry, style: pick(entry.style, (key) => own[key] === undefined) })).filter((entry) => Object.keys(entry.style).length);
      for (const entry of ownConditional.get(up) || []) { const style = pick(entry.style, (key) => INHERITED.includes(key)); if (Object.keys(style).length) out.conditional.push({ ...entry, style }); }
    }
    inherited.set(id, out);
    return out;
  };

  // an animation's name becomes its frames, each step through the same profile as any rule
  const animate = (style: RnStyle): void => {
    const name = style.animationName;
    if (typeof name !== 'string' || !name.startsWith(KEYFRAMES)) return;
    const frames = keyframesOf(name.slice(KEYFRAMES.length), sheet, (decls) => { const step: RnStyle = {}; for (const [prop, value] of decls) translate(prop, value, sheet.vars, step, gaps); finish(step, BASE_FONT); return step; }, gaps);
    if (frames) style.animationName = frames; else delete style.animationName;
  };

  const looks = new Map<string, NodeLook>();
  for (const [id, item] of Object.entries(doc.nodes)) {
    const own = ownBase.get(id) || {};
    // a text that is a flex box on the web (`display: flex` on a Span: an initials avatar, a time centered in its row)
    // lays its letters out as a box would: drawn as a box (View) with the text inside (tree.ts, look.boxed)
    const boxed = TEXT_NODES.has(item.type) && own.__flexRow !== undefined && (own.alignItems === 'center' || own.justifyContent === 'center') && typeof own.height !== 'number';
    const isText = TEXT_NODES.has(item.type) && !boxed;
    const heritage = inheritOf(id);
    const style: RnStyle = isText ? { ...(item.type === Nt.Title ? HEADING[item.props?.level || 'h1'] : {}), ...heritage.base, ...own } : { ...own };
    // the text a box shows (a Button's label, a field's value): what it inherits, with the box's own text style on top
    const text: RnStyle = { ...(boxed && item.type === Nt.Title ? HEADING[item.props?.level || 'h1'] : {}), ...heritage.base, ...pick(own, (key) => TEXT_ONLY.has(key)) };
    if (!isText) for (const key of Object.keys(style)) if (TEXT_ONLY.has(key)) delete style[key];
    const parentFont = typeof heritage.base.fontSize === 'number' ? heritage.base.fontSize : BASE_FONT;
    const look: NodeLook = { style, text, conditional: [], textProps: {}, live: [], ...extras.get(id), ...(boxed ? { boxed } : {}) };
    if (own.__grid !== undefined) {
      const plan = gridPlan(typeof own.__columns === 'string' ? own.__columns : undefined, typeof own.columnGap === 'number' ? own.columnGap : 0);
      if (typeof plan === 'string') gaps.push({ kind: 'value', what: 'grid', why: plan, level: 'none' }); else look.grid = plan;
    }
    // the node's own font size, taken before a box drops it (an em on a box is that box's size, not its parent's)
    const nodeFont = typeof own.fontSize === 'number' ? own.fontSize : emPoints(own.fontSize, parentFont) ?? parentFont;
    look.textProps = finish(style, parentFont, nodeFont);
    if (boxed) look.textProps = finish(text, parentFont);
    if (typeof own.__fit === 'string') look.fit = own.__fit;
    finish(text, parentFont);
    animate(style);
    if (isText) centerText(style);
    // the node's own conditionals, split as it draws them, then what reaches its text from above under a condition
    for (const entry of ownConditional.get(id) || []) {
      const box = { ...entry.style }, label: RnStyle = {};
      if (!isText) for (const key of Object.keys(box)) if (TEXT_ONLY.has(key)) { label[key] = box[key]; delete box[key]; }
      finish(box, parentFont); finish(label, parentFont); animate(box);
      look.conditional.push({ ...entry, style: box, text: label });
    }
    for (const entry of heritage.conditional) {
      const reach = pick(entry.style, (key) => own[key] === undefined);
      if (!Object.keys(reach).length) continue;
      finish(reach, parentFont);
      look.conditional.push(isText ? { ...entry, style: reach, text: {} } : { ...entry, style: {}, text: reach });
    }
    looks.set(id, look);
  }

  // the web lets a flex item shrink (flex-shrink: 1) and React Native does not (0): a long text beside an icon wraps on
  // the web and runs off the phone's screen. Only across a row: down a column the web never shrinks an item below its
  // content (min-height: auto), and React Native would, cutting buttons and headers in half. A grid sizes its own cells
  for (const [id, look] of looks) {
    const up = boxParent(id);
    const container = up ? looks.get(up) : undefined;
    const direction = container?.style.flexDirection;
    const inRow = (direction === 'row' || direction === 'row-reverse') && !container?.grid;
    if (inRow && node(id).type !== Nt.Image && look.style.flexShrink === undefined && look.style.flexGrow === undefined) look.style.flexShrink = 1;
  }
  // a percentage height inside a box with no height of its own is ignored by CSS (the box takes its content's height),
  // except where the box is stretched (a grid cell), which the 100 % then fills. flexGrow says both: it fills the room a
  // stretched parent has, and is nothing in a parent sized by its content. A grid's cells stretch to their row, as in CSS
  for (const [id, look] of looks) {
    const up = boxParent(id);
    const container = up ? looks.get(up) : undefined;
    if (container?.grid && node(id).type !== Nt.Image && look.style.flexGrow === undefined) look.style.flexGrow = 1;
    // `flex: 1` is flex-basis 0 %: a percentage of a column with no height is the content's size in CSS, and 0 on
    // the phone (the box collapses). In a row, whose width is known, it stays: equal shares of the width
    const column = !container || !String(container.style.flexDirection ?? 'column').startsWith('row');
    const basis = look.style.flexBasis;
    if (column && typeof container?.style.height !== 'number' && (basis === 0 || (typeof basis === 'string' && basis.endsWith('%')))) look.style.flexBasis = 'auto';
    const height = look.style.height;
    if (typeof height !== 'string' || !height.endsWith('%') || typeof container?.style.height === 'number') continue;
    delete look.style.height;
    if (height === '100%') { if (container?.style.flexDirection === 'row' || container?.style.flexDirection === 'row-reverse') look.style.alignSelf = 'stretch'; else look.style.flexGrow = 1; }
  }
  return { looks, gaps };
}

/** A node's classes: its primitive's own `mu-` class and every static class it carries. */
function classesOf(item: FlatNode): string[] {
  const out = ['mu-' + item.type.toLowerCase()];
  for (const entry of item.props?.class || []) if (typeof entry === 'string') out.push(...entry.split(/\s+/).filter(Boolean));
  return out;
}

/** The props of a style that pass `keep`. */
function pick(style: RnStyle, keep: (key: string) => boolean): RnStyle {
  const out: RnStyle = {};
  for (const [key, value] of Object.entries(style)) if (keep(key)) out[key] = value;
  return out;
}

// a text centered as a flex box on the web (an initials avatar: display flex, align-items and justify-content center)
// centers its own letters; a phone's Text ignores both. Across: textAlign. Down: a line as tall as the box, which
// Android and iOS both honor (textAlignVertical is Android only)
function centerText(style: RnStyle): void {
  if (style.justifyContent === 'center' && style.textAlign === undefined) style.textAlign = 'center';
  if (style.alignItems === 'center' && typeof style.height === 'number' && style.lineHeight === undefined) style.lineHeight = style.height;
}

/** An em length (`__em:1.5`) in points, for a font of `size`; undefined when the value is not one. */
function emPoints(value: RnStyle[string] | undefined, size: number): number | undefined {
  return typeof value === 'string' && value.startsWith(EM) ? Math.round(Number(value.slice(EM.length)) * size * 100) / 100 : undefined;
}

// the markers profile.ts leaves: the web's flex row, a grid, a line height as a factor, em lengths (the font size is
// known only now), and what is not style but Text props (how many lines, how the text is cut): returned
function finish(style: RnStyle, parentFont: number, nodeFont?: number): TextProps {
  if (style.__flexRow !== undefined) { if (style.flexDirection === undefined) style.flexDirection = 'row'; delete style.__flexRow; }
  if (style.__grid !== undefined) { style.flexDirection = 'row'; style.flexWrap = 'wrap'; delete style.columnGap; }   // the kit's Grid spaces the columns itself
  const fontEm = emPoints(style.fontSize, parentFont);
  if (fontEm !== undefined) style.fontSize = fontEm;
  const size = typeof style.fontSize === 'number' ? style.fontSize : nodeFont ?? parentFont;
  for (const [key, value] of Object.entries(style)) { const points = emPoints(value, size); if (points !== undefined) style[key] = points; }
  if (style.__lineHeightFactor !== undefined) {
    if (typeof style.__lineHeightFactor === 'number' && style.lineHeight === undefined) style.lineHeight = Math.round(style.__lineHeightFactor * size);
    delete style.__lineHeightFactor;
  }
  const props: TextProps = {};
  if (style.__lines !== undefined) { props.numberOfLines = Number(style.__lines); props.ellipsizeMode = 'tail'; }
  else if (style.__nowrap !== undefined) { props.numberOfLines = 1; props.ellipsizeMode = style.__ellipsis !== undefined ? 'tail' : 'clip'; }
  for (const marker of MARKERS) delete style[marker];
  return props;
}
