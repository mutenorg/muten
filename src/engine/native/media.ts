// media: an @media condition as a condition the phone checks while the app runs. The window's size and the system's
// color scheme are muten signals in the kit (`screen`), so a style under `@media (min-width: 768px)` turns on and off
// by itself when the phone rotates or the theme changes. What a phone never is (print, a hover pointer) is false;
// what it always is (screen, a coarse pointer) is true; anything else is a gap.
import { REM } from '#engine/native/units.js';

const PX_PER: { readonly [unit: string]: number } = { px: 1, em: REM, rem: REM };
// the kit's live screen: { width, height, dark }
const SCREEN = '__screen.get()';
const ALWAYS: { readonly [feature: string]: string } = {
  'hover: hover': 'false', 'hover: none': 'true', 'pointer: fine': 'false', 'pointer: coarse': 'true', 'any-hover: hover': 'false',
  'prefers-reduced-motion: reduce': 'false', 'prefers-reduced-motion: no-preference': 'true',
  'prefers-color-scheme: dark': `${SCREEN}.dark`, 'prefers-color-scheme: light': `!${SCREEN}.dark`,
  'orientation: portrait': `(${SCREEN}.height >= ${SCREEN}.width)`, 'orientation: landscape': `(${SCREEN}.width > ${SCREEN}.height)`,
};
const MEDIA_TYPES: { readonly [type: string]: string } = { screen: 'true', all: 'true', print: 'false', only: 'true' };

/** One `(feature: value)` as JavaScript, or null. */
function feature(text: string): string | null {
  const plain = text.replace(/\s+/g, ' ').replace(/\s*:\s*/, ': ').trim();
  if (ALWAYS[plain]) return ALWAYS[plain];
  const match = /^(min|max)-(width|height): ([\d.]+)(px|em|rem)$/.exec(plain);
  if (match) return `(${SCREEN}.${match[2]} ${match[1] === 'min' ? '>=' : '<='} ${Number(match[3]) * (PX_PER[match[4]] ?? 1)})`;
  const range = /^(width|height) (>=|<=|>|<) ([\d.]+)(px|em|rem)$/.exec(plain);
  if (range) return `(${SCREEN}.${range[1]} ${range[2]} ${Number(range[3]) * (PX_PER[range[4]] ?? 1)})`;
  return null;
}

/** `screen and (min-width: 768px)` → JavaScript over the kit's live screen, or null when it cannot be one. */
export function mediaCondition(condition: string): string | null {
  const alternatives = condition.split(/,(?![^(]*\))/);
  const out: string[] = [];
  for (const alternative of alternatives) {
    const terms: string[] = [];
    let negate = false;
    for (const piece of alternative.trim().split(/\s+and\s+/i)) {
      let term = piece.trim().toLowerCase();
      if (term.startsWith('not ')) { negate = true; term = term.slice(4).trim(); }
      if (term.startsWith('only ')) term = term.slice(5).trim();
      const js = term.startsWith('(') ? feature(term.slice(1, -1)) : MEDIA_TYPES[term] ?? null;
      if (js === null) return null;
      terms.push(js);
    }
    const joined = terms.join(' && ');
    out.push(negate ? `!(${joined})` : `(${joined})`);
  }
  return out.join(' || ');
}
