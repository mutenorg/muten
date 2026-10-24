// profile: the native CSS profile, one table. Every CSS property muten knows has one line here: how faithfully the
// phone says it (exact, approx with the difference stated, none with what to write instead) and how it translates.
// The same table is read by the compiler (translate), by `muten check` (what to warn while writing) and by the
// coverage test (no property used by an app may be undecided). A property that is not in the table is reported as
// unknown, never dropped in silence.
//
// What a translation cannot finish alone it leaves as a marker on the style (`__flexRow`, `__grid`, `__lines`…):
// styles.ts finishes it once the node's place in the tree is known.
import type { NativeGap, NativeLevel, ProfileNote, RnStyle } from '#engine/shared/types-native.js';
import { resolveVars } from '#engine/native/css.js';
import { length, isApproximate, plainNumber, sides, splitValue } from '#engine/native/units.js';
import { animation, transition, timeMs, curve } from '#engine/native/motion.js';

type Say = (level: NativeLevel, why: string) => void;
interface Rule extends ProfileNote { apply: (value: string, out: RnStyle, say: Say) => void }

// what each style prop takes on the phone. Android casts it with no mercy: a string where it reads a number is not
// ignored, it brings the whole screen down («String cannot be cast to Double»), and JavaScript never sees it. The
// same lists go into the generated app as muten-style-rules.js, so the check asks of every drawn element exactly
// what the compiler promised.
export const POINTS_ONLY = ['fontSize', 'letterSpacing', 'lineHeight', 'borderWidth', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'gap', 'rowGap', 'columnGap'];
export const NUMBERS_ONLY = ['flex', 'flexGrow', 'flexShrink', 'opacity', 'zIndex', 'elevation'];
export const LENGTH_OR_PERCENT = ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'top', 'right', 'bottom', 'left', 'flexBasis',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'paddingHorizontal', 'paddingVertical',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'marginHorizontal', 'marginVertical'];
const POINTS = new Set(POINTS_ONLY);
const ROUND = 9999;   // `border-radius: 50%` on the phone: as round as the box allows (a circle on a square, a pill on a bar)
const ALIGNS: { readonly [css: string]: string } = { start: 'flex-start', end: 'flex-end', left: 'flex-start', right: 'flex-end', normal: 'stretch' };
const align = (value: string): string => ALIGNS[value] ?? value;
const FONT_WEIGHTS: { readonly [css: string]: string } = { normal: '400', bold: '700', lighter: '300', bolder: '700' };
const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
const LINES = new Set(['underline', 'line-through', 'none']);

// ── the translations every line is made of ──────────────────────────

/** A length into `key`; points only for the props Android reads as numbers (a 50 % radius is the one exception). */
function lengthInto(out: RnStyle, key: string, raw: string, say: Say): void {
  const size = length(raw);
  if (size === null) { say('none', `${raw}: only px, rem, em, ch, %, vh/vw and calc() of absolute parts translate`); return; }
  if (isApproximate(raw)) say('approx', `${raw}: ch is taken as half an em; the real width of "0" depends on the font`);
  if (typeof size === 'string' && size.endsWith('%') && POINTS.has(key)) {
    if (key.endsWith('Radius') && Number(size.slice(0, -1)) >= 50) { out[key] = ROUND; say('approx', `${raw}: as round as the box allows (a pill on a box that is not square, where the web draws an ellipse)`); return; }
    say('none', `${raw}: ${key} takes points only on the phone (a percentage crashes the screen)`);
    return;
  }
  if (size === 'auto' && POINTS.has(key)) { say('none', `auto: ${key} takes points only on the phone`); return; }
  out[key] = size;
}
const lengthTo = (key: string): Rule['apply'] => (value, out, say) => lengthInto(out, key, value, say);
const wordTo = (key: string, map: (value: string) => string = (value) => value): Rule['apply'] => (value, out) => { out[key] = map(value); };
const numberTo = (key: string): Rule['apply'] => (value, out, say) => { const number = plainNumber(value); if (number === null) say('none', `${value}: a plain number`); else out[key] = number; };
const nothing: Rule['apply'] = () => {};
/** The four sides of a box property (`padding: 8px 12px`) into `prefix` + Top/Right/Bottom/Left `suffix`. */
const fourInto = (prefix: string, suffix = '', each: (out: RnStyle, key: string, raw: string, say: Say) => void = lengthInto): Rule['apply'] => (value, out, say) => {
  const four = sides(value);
  if (!four) { say('none', `${value}: one to four values`); return; }
  four.forEach((part, index) => each(out, `${prefix}${SIDES[index]}${suffix}`, part, say));
};
/** Two logical sides (`padding-inline: 8px 12px`) into a pair of physical ones. */
const pairInto = (first: string, second: string): Rule['apply'] => (value, out, say) => {
  const [a, b = a] = splitValue(value);
  lengthInto(out, first, a, say); lengthInto(out, second, b, say);
};

const exact = (apply: Rule['apply'], note = ''): Rule => ({ level: 'exact', note, apply });
const approx = (note: string, apply: Rule['apply']): Rule => ({ level: 'approx', note, apply });
const none = (note: string): Rule => ({ level: 'none', note, apply: (_value, _out, say) => say('none', note) });
const idle = (note: string): Rule => ({ level: 'exact', note, apply: nothing });   // nothing to do on a phone, and nothing lost

// ── the profile ──────────────────────────────────────────────────────

const PROPERTIES = new Map<string, Rule>();
const add = (names: string[], rule: Rule): void => { for (const name of names) PROPERTIES.set(name, rule); };

// sizes and position
for (const name of ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'top', 'right', 'bottom', 'left', 'flex-basis'])
  add([name], exact(lengthTo(name.replace(/-(\w)/g, (_whole, letter: string) => letter.toUpperCase()))));
add(['inset'], exact((value, out, say) => { const four = sides(value); if (!four) say('none', `${value}: one to four values`); else ['top', 'right', 'bottom', 'left'].forEach((key, index) => lengthInto(out, key, four[index], say)); }));
add(['inset-inline'], exact(pairInto('left', 'right')));
add(['inset-block'], exact(pairInto('top', 'bottom')));
add(['position'], exact((value, out, say) => {
  if (value === 'fixed') { out.position = 'absolute'; say('approx', 'position: fixed: absolute to the screen; it scrolls with the page instead of staying put'); return; }
  if (value === 'sticky') { say('none', 'position: sticky needs the list\'s own sticky header (stickyHeaderIndices)'); return; }
  out.position = value === 'static' ? 'relative' : value;
}));
add(['z-index'], exact(numberTo('zIndex')));
add(['aspect-ratio'], exact((value, out, say) => { const [a, b] = value.split('/').map((part) => Number(part.trim())); if (Number.isFinite(a)) out.aspectRatio = b ? a / b : a; else say('none', `${value}: a ratio like 16 / 9`); }));
add(['box-sizing'], idle('the phone always measures border-box'));

// box: padding, margin, border
add(['padding'], exact(fourInto('padding')));
add(['margin'], exact(fourInto('margin')));
for (const side of SIDES) {
  add([`padding-${side.toLowerCase()}`], exact(lengthTo(`padding${side}`)));
  add([`margin-${side.toLowerCase()}`], exact(lengthTo(`margin${side}`)));
  add([`border-${side.toLowerCase()}-width`], exact(lengthTo(`border${side}Width`)));
  add([`border-${side.toLowerCase()}-color`], exact(wordTo(`border${side}Color`)));
}
add(['padding-inline'], exact(pairInto('paddingLeft', 'paddingRight')));
add(['padding-block'], exact(pairInto('paddingTop', 'paddingBottom')));
add(['margin-inline'], exact(pairInto('marginLeft', 'marginRight')));
add(['margin-block'], exact(pairInto('marginTop', 'marginBottom')));
add(['border-width'], exact(fourInto('border', 'Width')));
add(['border-color'], exact((value, out) => { const four = sides(value); if (four && new Set(four).size > 1) four.forEach((part, index) => { out[`border${SIDES[index]}Color`] = part; }); else out.borderColor = value; }));
add(['border-style'], exact(wordTo('borderStyle', (value) => splitValue(value)[0])));
add(['border-radius'], exact((value, out, say) => {
  const corners = splitValue(value.split('/')[0]);
  if (corners.length === 1) { lengthInto(out, 'borderRadius', corners[0], say); return; }
  const [tl, tr = tl, br = tl, bl = tr] = corners;
  for (const [key, raw] of [['borderTopLeftRadius', tl], ['borderTopRightRadius', tr], ['borderBottomRightRadius', br], ['borderBottomLeftRadius', bl]]) lengthInto(out, key, raw, say);
}));
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'])
  add([`border-${corner}-radius`], exact(lengthTo(`border${corner.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('')}Radius`)));
const borderLine = (side: string): Rule['apply'] => (value, out, say) => {
  if (value === 'none' || value === '0') { out[`border${side}Width`] = 0; return; }
  for (const part of splitValue(value)) {
    const size = length(part);
    if (size !== null && part !== 'auto') lengthInto(out, `border${side}Width`, part, say);
    else if (/^(solid|dashed|dotted|none|double|groove|ridge|inset|outset)$/.test(part)) { if (!side) out.borderStyle = /^(dashed|dotted)$/.test(part) ? part : 'solid'; }
    else out[`border${side}Color`] = part;
  }
};
add(['border'], exact(borderLine('')));
for (const side of SIDES) add([`border-${side.toLowerCase()}`], exact(borderLine(side)));

// layout: flexbox (React Native's own), the web's defaults, grid
add(['display'], exact((value, out, say) => {
  if (value === 'none') out.display = 'none';
  else if (value === 'flex' || value === 'inline-flex') out.__flexRow = 1;   // the web's flex is a row: styles.ts writes it unless a direction says otherwise
  else if (value === 'grid' || value === 'inline-grid') out.__grid = 1;      // grid.ts lays the columns out
  else if (value === 'inline' || value === 'inline-block') say('approx', `display: ${value}: no inline boxes on the phone; a piece inside text keeps its color and weight, a box stacks`);
  else if (value === '-webkit-box') out.__webkitBox = 1;                      // the line-clamp idiom
}));
add(['flex-direction'], exact(wordTo('flexDirection')));
add(['flex-wrap'], exact(wordTo('flexWrap')));
add(['flex-flow'], exact((value, out) => { for (const part of splitValue(value)) out[/wrap/.test(part) ? 'flexWrap' : 'flexDirection'] = part; }));
add(['flex'], exact((value, out, say) => {
  if (value === 'none') { out.flexGrow = 0; out.flexShrink = 0; return; }
  if (value === 'auto') { out.flexGrow = 1; out.flexShrink = 1; out.flexBasis = 'auto'; return; }
  const parts = splitValue(value);
  const grow = plainNumber(parts[0]);
  if (grow === null) { say('none', `${value}: a number (flex: 1) or "grow shrink basis"`); return; }
  out.flexGrow = grow;
  out.flexShrink = parts[1] !== undefined && plainNumber(parts[1]) !== null ? Number(parts[1]) : 1;
  const basis = parts.length === 1 ? '0%' : parts[parts.length - 1];
  if (parts.length === 1 || plainNumber(basis) === null) lengthInto(out, 'flexBasis', basis, say);
}));
add(['flex-grow'], exact(numberTo('flexGrow')));
add(['flex-shrink'], exact(numberTo('flexShrink')));
for (const [css, key] of [['align-items', 'alignItems'], ['align-self', 'alignSelf'], ['align-content', 'alignContent'], ['justify-content', 'justifyContent']]) add([css], exact(wordTo(key, align)));
add(['justify-items', 'justify-self'], none('justify-items/justify-self belong to grid cells: align the cell\'s own content'));
add(['place-items', 'place-content'], exact((value, out) => { const [first, second = first] = splitValue(value); out.alignItems = align(first); out.justifyContent = align(second); }));
add(['place-self'], exact(wordTo('alignSelf', (value) => align(splitValue(value)[0]))));
add(['gap', 'grid-gap'], exact((value, out, say) => { const [row, column = row] = splitValue(value); lengthInto(out, 'rowGap', row, say); lengthInto(out, 'columnGap', column, say); }));
add(['row-gap', 'grid-row-gap'], exact(lengthTo('rowGap')));
add(['column-gap', 'grid-column-gap'], exact(lengthTo('columnGap')));
add(['grid-template-columns'], exact((value, out) => { out.__columns = value; }));   // grid.ts reads the tracks
add(['grid-template-rows', 'grid-auto-rows'], approx('rows take their content\'s height; a fixed row height is not kept', nothing));
add(['grid-auto-flow'], approx('cells always fill row by row', nothing));
add(['grid-template-areas', 'grid-area', 'grid-row', 'grid-row-start', 'grid-row-end'], none('named areas and row placement: lay the cells out in source order, or with nested flex rows'));
add(['grid-column', 'grid-column-start', 'grid-column-end'], none('column spans and placement: give the wide cell its own row'));
add(['order'], none('order: write the nodes in the order they show'));

// text
add(['color'], exact(wordTo('color')));
add(['font-size'], exact(lengthTo('fontSize')));
add(['font-weight'], exact(wordTo('fontWeight', (value) => FONT_WEIGHTS[value] ?? value)));
add(['font-style'], exact(wordTo('fontStyle')));
add(['font-family'], approx('the phone shows the first family it has: load the font with expo-font, or it falls back to the system font', wordTo('fontFamily', (value) => splitValue(value.replace(/,.*/, ''))[0].replace(/["']/g, ''))));
add(['font'], approx('the shorthand gives size, weight, style and line height; the family needs the font loaded on the phone', (value, out, say) => {
  for (const part of splitValue(value)) {
    if (/^(italic|oblique)$/.test(part)) out.fontStyle = 'italic';
    else if (/^(\d00|bold|normal|lighter|bolder)$/.test(part) && out.fontSize === undefined) out.fontWeight = FONT_WEIGHTS[part] ?? part;
    else if (/^[\d.]+(px|rem|em)?\//.test(part)) { const [size, line] = part.split('/'); lengthInto(out, 'fontSize', size, say); const factor = plainNumber(line); if (factor !== null) out.__lineHeightFactor = factor; else lengthInto(out, 'lineHeight', line, say); }
    else if (length(part) !== null && out.fontSize === undefined) lengthInto(out, 'fontSize', part, say);
  }
}));
add(['line-height'], exact((value, out, say) => { const factor = plainNumber(value); if (factor !== null) out.__lineHeightFactor = factor; else if (value === 'normal') return; else lengthInto(out, 'lineHeight', value, say); }));
add(['letter-spacing'], exact((value, out, say) => { if (value !== 'normal') lengthInto(out, 'letterSpacing', value, say); }));
add(['text-align'], exact(wordTo('textAlign', (value) => (value === 'start' ? 'left' : value === 'end' ? 'right' : value))));
add(['text-transform'], exact(wordTo('textTransform')));
add(['text-decoration', 'text-decoration-line'], exact((value, out) => {
  const lines = splitValue(value).filter((part) => LINES.has(part));
  const color = splitValue(value).find((part) => !LINES.has(part) && length(part) === null && !/^(solid|dashed|dotted|wavy|double)$/.test(part));
  out.textDecorationLine = lines.length > 1 ? 'underline line-through' : lines[0] ?? 'none';
  if (color) out.textDecorationColor = color;
}));
add(['text-decoration-color'], exact(wordTo('textDecorationColor')));
add(['text-decoration-style'], exact(wordTo('textDecorationStyle')));
add(['text-decoration-thickness', 'text-underline-offset'], approx('the phone draws its own line thickness and offset', nothing));
add(['vertical-align'], approx('only Android moves text vertically, and only inside text', wordTo('verticalAlign')));
add(['font-variant-numeric'], exact((value, out) => { out.fontVariant = splitValue(value).filter((part) => /^(tabular-nums|oldstyle-nums|lining-nums|proportional-nums|small-caps)$/.test(part)); }));
add(['font-feature-settings'], approx('font features need the font\'s own support on the phone: tabular numbers go through font-variant-numeric', nothing));
add(['white-space'], exact((value, out) => { if (value === 'nowrap' || value === 'pre') out.__nowrap = 1; }));
add(['text-overflow'], exact((value, out) => { if (value === 'ellipsis') out.__ellipsis = 1; }));
add(['-webkit-line-clamp', 'line-clamp'], exact((value, out, say) => { const lines = plainNumber(value); if (lines === null) say('none', `${value}: a number of lines`); else out.__lines = lines; }));
add(['-webkit-box-orient'], idle('part of the line-clamp idiom'));
add(['word-break', 'overflow-wrap', 'word-wrap', 'hyphens'], approx('the phone breaks words its own way: a long word wraps where the system decides', nothing));
add(['text-shadow'], approx('one shadow only, without spread', (value, out) => {
  const parts = splitValue(value.split(/,(?![^(]*\))/)[0]);
  const numbers = parts.map((part) => length(part)).filter((size): size is number => typeof size === 'number');
  const color = parts.find((part) => length(part) === null);
  out.textShadowOffset = { width: numbers[0] ?? 0, height: numbers[1] ?? 0 };
  out.textShadowRadius = numbers[2] ?? 0;
  if (color) out.textShadowColor = color;
}));

// paint
add(['background-color'], exact(wordTo('backgroundColor')));
add(['background'], exact((value, out, say) => {
  if (/url\(/.test(value)) { say('none', 'a picture as background: put an Image behind the content (position absolute, inset 0)'); return; }
  if (/gradient\(/.test(value)) { out.experimental_backgroundImage = value; say('approx', 'a gradient as background: drawn by React Native\'s new architecture (linear and radial), without background-size or repeat'); return; }
  out.backgroundColor = value;
}));
add(['background-image'], exact((value, out, say) => {
  if (/gradient\(/.test(value)) { out.experimental_backgroundImage = value; say('approx', 'a gradient: drawn by React Native\'s new architecture (linear and radial), without background-size or repeat'); return; }
  if (value !== 'none') say('none', 'a picture as background: put an Image behind the content (position absolute, inset 0)');
}));
add(['background-size', 'background-position', 'background-repeat', 'background-clip', 'background-attachment', 'background-origin'], none('the phone has no background pictures: an Image behind the content has its own fit (object-fit)'));
add(['opacity'], exact(numberTo('opacity')));
add(['box-shadow'], exact(wordTo('boxShadow')));
add(['filter'], approx('the filters React Native draws (brightness, opacity, blur, drop-shadow…) on its new architecture; blur only on Android 12+', wordTo('filter')));
add(['backdrop-filter', '-webkit-backdrop-filter'], none('blur behind a box needs expo-blur (BlurView)'));
add(['mix-blend-mode'], exact(wordTo('mixBlendMode')));
add(['isolation'], exact(wordTo('isolation')));
add(['overflow', 'overflow-x', 'overflow-y'], exact((value, out, say) => {
  out.overflow = value === 'visible' ? 'visible' : 'hidden';
  if (value === 'auto' || value === 'scroll') say('approx', `overflow: ${value}: the box clips; scrolling inside it needs its own ScrollView`);
}));
add(['visibility'], approx('visibility: hidden is taken as transparent; the box still answers touches', (value, out) => { if (value === 'hidden') out.opacity = 0; }));
add(['transform'], exact(wordTo('transform')));
add(['transform-origin'], exact(wordTo('transformOrigin')));
add(['object-fit'], exact((value, out) => { out.__fit = value; }));
add(['object-position'], approx('pictures stay centered in their box', nothing));
add(['pointer-events'], exact(wordTo('pointerEvents', (value) => (value === 'none' ? 'none' : 'auto'))));
add(['content'], none('generated content (::before, ::after): write it as a node'));

// motion: Reanimated 4's CSS animations and transitions (motion.ts), on an Animated.View
const msTo = (key: string): Rule['apply'] => (value, out, say) => { const ms = timeMs(value); if (ms === null) say('none', `${value}: a time in s or ms`); else out[key] = ms; };
const curveTo = (key: string): Rule['apply'] => (value, out, say) => { const found = curve(value); if (found) out[key] = found; else say('none', `${value}: a keyword, cubic-bezier() or steps()`); };
add(['animation'], exact((value, out, say) => animation(value, out, (why) => say('approx', why))));
add(['animation-name'], exact((value, out) => { if (value !== 'none') out.animationName = `__frames:${value.split(',')[0].trim()}`; }));
add(['animation-duration'], exact(msTo('animationDuration')));
add(['animation-delay'], exact(msTo('animationDelay')));
add(['animation-timing-function'], exact(curveTo('animationTimingFunction')));
add(['animation-iteration-count'], exact((value, out) => { out.animationIterationCount = value === 'infinite' ? 'infinite' : Number(value); }));
add(['animation-direction'], exact(wordTo('animationDirection')));
add(['animation-fill-mode'], exact(wordTo('animationFillMode')));
add(['animation-play-state'], exact(wordTo('animationPlayState')));
add(['transition'], exact((value, out) => transition(value, out)));
add(['transition-property'], exact((value, out) => { out.transitionProperty = value.split(',').map((name) => name.trim().replace(/-(\w)/g, (_whole, letter: string) => letter.toUpperCase())); }));
add(['transition-duration'], exact(msTo('transitionDuration')));
add(['transition-delay'], exact(msTo('transitionDelay')));
add(['transition-timing-function'], exact(curveTo('transitionTimingFunction')));
add(['will-change'], idle('a hint for the browser'));

// what a phone has no use for: nothing to do, nothing lost
add(['cursor'], idle('there is no pointer on a phone'));
add(['user-select', '-webkit-user-select'], idle('text on a phone is not selectable unless asked'));
add(['outline', 'outline-offset', 'outline-color', 'outline-width', 'outline-style'], idle('keyboard focus rings belong to the web'));
add(['appearance', '-webkit-appearance'], idle('the phone draws its own controls'));
add(['-webkit-tap-highlight-color', 'touch-action', '-webkit-font-smoothing', '-moz-osx-font-smoothing', 'text-rendering', 'scroll-behavior', 'scrollbar-width', 'overscroll-behavior', 'list-style', 'list-style-type', 'resize', 'caret-color', 'accent-color', 'color-scheme', 'contain', 'content-visibility', 'speak', 'tab-size'],
  idle('a browser setting with no meaning on the phone'));

/** The whole profile, for `muten check`, the coverage test and the docs. */
export const PROFILE: ReadonlyArray<[string, ProfileNote]> = [...PROPERTIES].map(([name, rule]) => [name, { level: rule.level, note: rule.note }]);

/** One declaration into `into`; what does not translate exactly is a gap (with its level) in `gaps`. */
export function translate(name: string, raw: string, vars: { [name: string]: string }, into: RnStyle, gaps: NativeGap[], line?: number): void {
  const value = resolveVars(raw, vars);
  const rule = PROPERTIES.get(name);
  if (!rule) { gaps.push({ kind: 'property', what: name, why: 'not in muten\'s native CSS profile yet', level: 'none', line }); return; }
  if (rule.level === 'none') { gaps.push({ kind: 'property', what: name, why: rule.note, level: 'none', line }); return; }
  if (rule.level === 'approx') gaps.push({ kind: 'property', what: name, why: rule.note, level: 'approx', line });
  rule.apply(value, into, (level, why) => gaps.push({ kind: 'value', what: `${name}: ${raw}`, why, level, line }));
}
