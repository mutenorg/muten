// selectors: a CSS selector read into what muten can match against its tree at compile time. A compound is a tag (the
// one the web output gives the node: `.fld input`, `.pdark p`), `*`, classes, and pseudo-classes:
//   · structure (:first-child, :last-child, :only-child, :nth-child, :nth-last-child): decided at compile time for a
//     node among fixed siblings, and on the phone by the row's index for a node repeated by `each`;
//   · state: :disabled (the node's own `disabled when …`), :active (the press of a Button or Link), :focus (a field);
//     :hover never happens on a touch screen;
//   · ::placeholder: a field's placeholder color.
// What muten cannot know (ids, attributes, siblings, ::before) is a reason string, reported as a gap.
import { Nt } from '#engine/shared/vocab.js';

export interface Nth { a: number; b: number; fromEnd: boolean }
export interface Compound { tag?: string; classes: string[]; nths: Nth[]; states: string[] }
export interface Selector { parts: Compound[]; combinators: string[]; weight: number; text: string; placeholder: boolean; hover: boolean }

export const STATE_DISABLED = 'disabled', STATE_ACTIVE = 'active', STATE_FOCUS = 'focus';
const STATES: { readonly [pseudo: string]: string } = { disabled: STATE_DISABLED, active: STATE_ACTIVE, focus: STATE_FOCUS, 'focus-visible': STATE_FOCUS };
const IGNORED_ELEMENTS = new Set(['selection', '-webkit-scrollbar', 'scrollbar', '-webkit-scrollbar-thumb', 'marker']);

/** The tag the web output gives each primitive: what an element selector names. */
// an Icon is a span with the svg inside on the web: `.ib svg` and `.ib span` both reach it
export const ICON_TAGS = ['span', 'svg'];
export const TAG_OF: { readonly [type: string]: string } = {
  [Nt.Page]: 'main', [Nt.Stack]: 'div', [Nt.Header]: 'header', [Nt.Nav]: 'nav', [Nt.Sidebar]: 'aside', [Nt.Footer]: 'footer',
  [Nt.Section]: 'section', [Nt.Article]: 'article', [Nt.List]: 'ul', [Nt.Details]: 'details', [Nt.Text]: 'p', [Nt.Span]: 'span',
  [Nt.Image]: 'img', [Nt.Link]: 'a', [Nt.Button]: 'button', [Nt.SearchField]: 'input', [Nt.Password]: 'input', [Nt.Number]: 'input',
  [Nt.Date]: 'input', [Nt.Range]: 'input', [Nt.Checkbox]: 'input', [Nt.Textarea]: 'textarea', [Nt.Select]: 'select',
  [Nt.Form]: 'form', [Nt.Table]: 'table', [Nt.Row]: 'tr', [Nt.Cell]: 'td', [Nt.Svg]: 'svg', [Nt.Video]: 'video',
};

/** `odd`, `even`, `3`, `2n+1`, `-n+3` → a and b of an+b. */
function nth(source: string, fromEnd: boolean): Nth | null {
  const text = source.replace(/\s+/g, '').toLowerCase();
  if (text === 'odd') return { a: 2, b: 1, fromEnd };
  if (text === 'even') return { a: 2, b: 0, fromEnd };
  const match = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(text);
  if (!match) return null;
  if (match[3] !== undefined) return { a: 0, b: Number(match[3]), fromEnd };
  const a = match[1] === '' || match[1] === '+' ? 1 : match[1] === '-' ? -1 : Number(match[1]);
  return { a, b: Number(match[2] || 0), fromEnd };
}

/** Whether a 1-based position is picked by an+b. */
export function picks(rule: Nth, position: number): boolean {
  if (rule.a === 0) return position === rule.b;
  const steps = (position - rule.b) / rule.a;
  return Number.isInteger(steps) && steps >= 0;
}

/** One compound (`input.big:first-child`), or the reason it cannot be matched. */
function compound(token: string, into: Selector): Compound | string {
  const out: Compound = { classes: [], nths: [], states: [] };
  const head = /^(\*|[a-z][a-z0-9-]*)/i.exec(token);
  let rest = token;
  if (head) { if (head[1] !== '*') { out.tag = head[1].toLowerCase(); into.weight += 1; } rest = token.slice(head[1].length); }
  for (const part of rest.match(/\.[\w-]+|::?[\w-]+(?:\([^)]*\))?|\[[^\]]*\]|#[\w-]+|./g) || []) {
    if (part.startsWith('.')) { out.classes.push(part.slice(1)); into.weight += 10; continue; }
    if (part.startsWith('#')) return 'an id selector: muten nodes carry classes, not ids';
    if (part.startsWith('[')) return 'an attribute selector: muten nodes carry classes, not attributes';
    if (part.startsWith('::')) {
      const element = part.slice(2);
      if (element === 'placeholder') { into.placeholder = true; continue; }
      if (IGNORED_ELEMENTS.has(element)) return `::${element} has nothing to style on the phone`;
      return `::${element} is not a node on the phone: write the content as a node`;
    }
    if (part.startsWith(':')) {
      const [name, argument] = [part.slice(1).replace(/\(.*$/, ''), /\((.*)\)$/.exec(part)?.[1] ?? ''];
      into.weight += 10;
      if (name === 'hover') { into.hover = true; continue; }
      if (STATES[name]) { out.states.push(STATES[name]); continue; }
      if (name === 'first-child') { out.nths.push({ a: 0, b: 1, fromEnd: false }); continue; }
      if (name === 'last-child') { out.nths.push({ a: 0, b: 1, fromEnd: true }); continue; }
      if (name === 'only-child') { out.nths.push({ a: 0, b: 1, fromEnd: false }, { a: 0, b: 1, fromEnd: true }); continue; }
      if (name === 'nth-child' || name === 'nth-last-child') { const rule = nth(argument, name === 'nth-last-child'); if (!rule) return `:${name}(${argument}): an+b, odd or even`; out.nths.push(rule); continue; }
      return `:${name}: a state muten cannot know on the phone (only :first-child, :last-child, :nth-child, :disabled, :active, :focus translate)`;
    }
    return `"${part}" is not part of a selector muten reads`;
  }
  return out;
}

/** `.list > .row.on`, `.fld input`, `.li:last-child` → its compounds right to left, or a gap reason. */
export function parseSelector(text: string): Selector | string {
  if (/[+~]/.test(text.replace(/\([^)]*\)/g, ''))) return 'a sibling selector (+, ~): give the node its own class';
  const selector: Selector = { parts: [], combinators: [], weight: 0, text, placeholder: false, hover: false };
  const tokens = text.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
  const parts: Compound[] = []; const combinators: string[] = [];
  for (const token of tokens) {
    if (token === '>') { combinators.push('>'); continue; }
    if (parts.length > combinators.length) combinators.push(' ');
    const read = compound(token, selector);
    if (typeof read === 'string') return read;
    parts.push(read);
  }
  selector.parts = parts.reverse();
  selector.combinators = combinators.reverse();
  return selector;
}
