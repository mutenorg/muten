// units: a CSS length as React Native takes it. React Native lengths are points (a number), a percentage string, or
// 'auto'; everything else the web writes is turned into one of those here, or into a marker resolved later:
//   px → points · rem → 16 points · em → the node's own font size (a marker: styles.ts knows the size once the
//   cascade is done) · ch → half an em (an approximation: the real width of "0" depends on the font) · vh/vw (and
//   dvh/svh/lvh) → a share of the window (a marker: the screen module turns it into a number when the app starts)
// calc() is evaluated when its parts are absolute (px, rem, numbers); a calc that mixes a percentage with points has
// no React Native form.

export const REM = 16;   // the web's default root size: 1rem = 16 points
const CH_PER_EM = 0.5;
export const EM = '__em:';   // `__em:1.5`: 1.5 times the node's font size
export const VIEW = '__view:';   // `__view:h:46`: 46 % of the window's height (w: its width)

export type Length = number | string;

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/;
const SIZED = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|ch|%|vh|vw|dvh|svh|lvh|dvw|svw|lvw|vmin|vmax)?$/;

/** A CSS length as React Native takes it, or null when it has no form there. */
export function length(raw: string): Length | null {
  const value = raw.trim().toLowerCase();
  if (value === '0') return 0;
  if (value === 'auto') return 'auto';
  if (value.startsWith('calc(')) return calc(value.slice(5, -1));
  const match = SIZED.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  const unit = match[2] || 'px';
  if (unit === 'px') return number;
  if (unit === 'rem') return number * REM;
  if (unit === '%') return `${number}%`;
  if (unit === 'em') return `${EM}${number}`;
  if (unit === 'ch') return `${EM}${number * CH_PER_EM}`;
  if (unit.endsWith('h') && unit !== 'ch') return `${VIEW}h:${number}`;
  if (unit.endsWith('w')) return `${VIEW}w:${number}`;
  return null;   // vmin/vmax: they need both sides of the window at once
}

/** Whether a length is only close to the web's (ch). */
export const isApproximate = (raw: string): boolean => /\dch\b/.test(raw);

/** A number (opacity, z-index, flex-grow), or null. */
export function plainNumber(raw: string): number | null {
  const value = raw.trim();
  return NUMBER.test(value) ? Number(value) : null;
}

// ── calc ──────────────────────────────────────────────────────────────

/** `16px + 2rem`, `2 * 8px`, `(100px - 20px) / 2`: points, or null when a part is not absolute. */
function calc(source: string): number | null {
  const tokens = source.match(/-?(?:\d+\.?\d*|\.\d+)[a-z%]*|[-+*/()]/gi);
  if (!tokens) return null;
  let at = 0;
  // the usual grammar: a sum of products of factors; a factor is a length, a number or a parenthesis
  const factor = (): number | null => {
    const token = tokens[at++];
    if (token === '(') { const inner = sum(); at++; return inner; }
    if (token === undefined) return null;
    if (NUMBER.test(token)) return Number(token);
    const size = length(token);
    return typeof size === 'number' ? size : null;
  };
  const product = (): number | null => {
    let left = factor();
    while (left !== null && (tokens[at] === '*' || tokens[at] === '/')) {
      const op = tokens[at++];
      const right = factor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const sum = (): number | null => {
    let left = product();
    while (left !== null && (tokens[at] === '+' || tokens[at] === '-')) {
      const op = tokens[at++];
      const right = product();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  const out = sum();
  return out !== null && at === tokens.length && Number.isFinite(out) ? Math.round(out * 100) / 100 : null;
}

/** `8px 12px` → the four sides, as CSS reads one to four values. */
export function sides(value: string): [string, string, string, string] | null {
  const parts = splitValue(value);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return null;
}

/** A value's parts split on spaces, keeping what is inside parentheses together (`calc(1px + 2px) 4px`). */
export function splitValue(value: string): string[] {
  const parts: string[] = [];
  let depth = 0, current = '';
  for (const char of value.trim()) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (/\s/.test(char) && depth === 0) { if (current) parts.push(current); current = ''; continue; }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}
