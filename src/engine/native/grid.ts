// grid: a CSS grid's columns, for the kit's Grid (native-kit/native.jsx). React Native has only flexbox; a grid is a
// wrapping row whose cells get their width from the container's measured width and the tracks: `repeat(3, 1fr)`,
// `1fr 2fr`, `120px 1fr`, `minmax(0, 1fr)`. A track sized by its content (auto, min-content) lays its row out as a
// single flex row (the cells take their content's width), which is what such grids nearly always are.
import type { GridPlan, GridTrack } from '#engine/shared/types-native.js';
import { length, splitValue } from '#engine/native/units.js';

/** `repeat(3, 1fr)` → `1fr 1fr 1fr` (auto-fill and auto-fit need the width first: no). */
function expand(value: string): string | null {
  let out = value;
  for (let pass = 0; pass < 4 && out.includes('repeat('); pass++) {
    const match = /repeat\(\s*([^,]+)\s*,\s*((?:[^()]|\([^()]*\))+)\)/.exec(out);
    if (!match) return null;
    const times = Number(match[1]);
    if (!Number.isInteger(times) || times < 1) return null;   // auto-fill / auto-fit
    out = out.replace(match[0], Array(times).fill(match[2].trim()).join(' '));
  }
  return out;
}

/** One track: `1fr`, `minmax(0, 2fr)`, `120px`, `auto`. */
function track(raw: string): GridTrack | null {
  const value = raw.trim();
  const minmax = /^minmax\(\s*[^,]+,\s*(.+)\)$/.exec(value);
  if (minmax) return track(minmax[1]);
  const fraction = /^([\d.]+)fr$/.exec(value);
  if (fraction) return { fr: Number(fraction[1]) };
  if (/^(auto|min-content|max-content|fit-content.*)$/.test(value)) return { auto: true };
  const size = length(value);
  return typeof size === 'number' ? { width: size } : null;
}

/** The grid's plan, or a reason it has none. */
export function gridPlan(columns: string | undefined, columnGap: number): GridPlan | string {
  if (!columns) return { tracks: [{ fr: 1 }], columnGap };   // a grid with no columns is one column
  const expanded = expand(columns);
  if (!expanded) return `grid-template-columns: ${columns}: repeat(auto-fill/auto-fit) needs the width first; write the number of columns`;
  const tracks = splitValue(expanded).map(track);
  if (tracks.some((one) => one === null)) return `grid-template-columns: ${columns}: fr, px, rem, minmax() and auto translate`;
  return { tracks: tracks.filter((one): one is GridTrack => one !== null), columnGap };
}
