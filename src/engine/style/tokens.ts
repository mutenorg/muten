// Muten styling = LAYOUT + TYPOGRAPHY VOCABULARY only. This domain owns the *vocabulary* (which
// token families/atoms exist and the CSS each maps to) — the engine's single source of truth for
// what styling it accepts. It owns NO values: the scale (md=16px…) and breakpoint pixels come from
// the project's theme.muten, and the reset/base lives in the project's stylesheet.
// So: vocabulary = engine; values + look = project.

import type { Theme, ThemeScale, FamilyFn } from '#engine/shared/types.js';

// fixed keyword → CSS maps — token SEMANTICS, not configurable theme values. Genuine string→string
// lookup tables, so a Map (not a phantom Record): clean .get()/.has() with no index-signature holes.
const JUSTIFY = new Map<string, string>([
  ['start', 'flex-start'], ['center', 'center'], ['end', 'flex-end'],
  ['between', 'space-between'], ['around', 'space-around'], ['evenly', 'space-evenly'],
]);
const ITEMS = new Map<string, string>([
  ['start', 'flex-start'], ['center', 'center'], ['end', 'flex-end'],
  ['stretch', 'stretch'], ['baseline', 'baseline'],
]);
const ATOMS = new Map<string, string>([ // tokens with NO modifier (the common layout keywords)
  ['row', 'display:flex;flex-direction:row'], ['column', 'display:flex;flex-direction:column'],
  ['wrap', 'flex-wrap:wrap'], ['grid', 'display:grid'], ['grow', 'flex:1'],
  ['center', 'align-items:center'], ['between', 'justify-content:space-between'],
  ['bold', 'font-weight:700'], ['italic', 'font-style:italic'],
]);

// a named scale step (looked up in the PROJECT's theme table) OR a literal number → px.
const len = (m: string, table: ThemeScale): string | null => table[m] ?? (/^\d+$/.test(m) ? m + 'px' : null);
const axis = (m: string, prop: string, sp: ThemeScale): string | null => {
  if (m.startsWith('x.')) { const v = len(m.slice(2), sp); return v ? `${prop}-left:${v};${prop}-right:${v}` : null; }
  if (m.startsWith('y.')) { const v = len(m.slice(2), sp); return v ? `${prop}-top:${v};${prop}-bottom:${v}` : null; }
  const v = len(m, sp); return v ? `${prop}:${v}` : null;
};

// family -> (modifier, theme) => css | null. The KEYS are the accepted vocabulary (source of truth).
const FAMILIES: { [family: string]: FamilyFn } = {
  gap:     (m, t) => { const v = len(m, t.space); return v ? `gap:${v}` : null; },
  padding: (m, t) => axis(m, 'padding', t.space),
  margin:  (m, t) => axis(m, 'margin', t.space),
  cols:    (m)    => m === 'auto' ? 'grid-template-columns:repeat(auto-fill,minmax(160px,1fr))' : (/^\d+$/.test(m) ? `grid-template-columns:repeat(${m},1fr)` : null),
  rows:    (m)    => /^\d+$/.test(m) ? `grid-template-rows:repeat(${m},1fr)` : null,
  text:    (m, t) => { const v = len(m, t.font); return v ? `font-size:${v}` : null; },
  weight:  (m, t) => { const v = t.weight[m] ?? (/^\d+$/.test(m) ? m : null); return v ? `font-weight:${v}` : null; },
  leading: (m, t) => { const v = t.leading[m] ?? (/^[\d.]+$/.test(m) ? m : null); return v ? `line-height:${v}` : null; },
  align:   (m)    => ['left', 'center', 'right', 'justify'].includes(m) ? `text-align:${m}` : null,
  justify: (m)    => { const v = JUSTIFY.get(m); return v ? `justify-content:${v}` : null; },
  items:   (m)    => { const v = ITEMS.get(m); return v ? `align-items:${v}` : null; },
  width:   (m, t) => m === 'full' ? 'width:100%' : (len(m, t.space) ? `width:${len(m, t.space)}` : null),
  height:  (m, t) => m === 'full' ? 'height:100%' : (len(m, t.space) ? `height:${len(m, t.space)}` : null),
};

// THE ACCEPTED VOCABULARY (source of truth for strict validation + autocomplete)
export const FAMILY_NAMES = Object.keys(FAMILIES);
export const ATOM_NAMES = [...ATOMS.keys()];
export const BREAKPOINT_NAMES = ['sm', 'md', 'lg', 'xl']; // accepted prefixes; their px live in the theme

// The engine ships NO values: empty scales. The PROJECT fills them. There is NO `base`/reset here —
// the reset/base CSS lives in the project's stylesheet (CSS belongs with CSS, not in a Muten string).
export const defaultTheme: Theme = { space: {}, font: {}, weight: {}, leading: {}, breakpoints: {} };

// merge a project theme over the (empty) defaults — per scale, so you can define exactly what you use
export function mergeTheme(theme: { [scale: string]: ThemeScale } = {}): Theme {
  return {
    space:       { ...(theme.space || {}) },
    font:        { ...(theme.font || {}) },
    weight:      { ...(theme.weight || {}) },
    leading:     { ...(theme.leading || {}) },
    breakpoints: { ...(theme.breakpoints || {}) },
  };
}

// token -> CSS declarations using the PROJECT's theme, or null if the token is invalid/unresolved.
export function resolveToken(t: string, theme: Theme = defaultTheme): string | null {
  const c = t.indexOf(':');
  if (c > 0 && theme.breakpoints[t.slice(0, c)]) return resolveToken(t.slice(c + 1), theme); // strip breakpoint
  const atom = ATOMS.get(t);
  if (atom) return atom;
  const d = t.indexOf('.');
  if (d < 0) return null;
  const fam = FAMILIES[t.slice(0, d)];
  return fam ? (fam(t.slice(d + 1), theme) || null) : null;
}

// is the token's SHAPE in the accepted vocabulary? (family/atom known — independent of theme values)
export function isKnownTokenShape(t: string): boolean {
  const c = t.indexOf(':');
  const base = c > 0 && BREAKPOINT_NAMES.includes(t.slice(0, c)) ? t.slice(c + 1) : t;
  if (ATOMS.has(base)) return true;
  const d = base.indexOf('.');
  return d > 0 && FAMILY_NAMES.includes(base.slice(0, d));
}

// a token's class name: padding.x.md -> t-padding-x-md ; md:cols.3 -> t-md-cols-3
export const tokenClass = (t: string): string => 't-' + t.replace(/[.:]/g, '-');

// curated list for autocomplete + highlight (validation accepts the full OPEN set via the vocabulary)
export const SUGGESTED = [
  'row', 'column', 'wrap', 'grid', 'grow', 'center', 'between', 'bold', 'italic',
  'gap.sm', 'gap.md', 'gap.lg', 'padding.md', 'padding.lg', 'padding.x.md', 'padding.y.md', 'margin.md',
  'cols.2', 'cols.3', 'cols.auto', 'rows.2',
  'text.sm', 'text.md', 'text.lg', 'text.xl', 'weight.medium', 'weight.bold', 'leading.normal',
  'align.left', 'align.center', 'align.right', 'justify.center', 'justify.between', 'items.center', 'items.start',
  'width.full', 'height.full',
  'md:row', 'md:cols.2', 'md:cols.3', 'lg:cols.4', // responsive: prefix any token with sm:/md:/lg:/xl:
];
