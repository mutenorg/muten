// json: a value as a folding tree, colored by kind. An object says how many fields it has, a list how many items; a
// long list or a deep object starts folded, so a 5 000-row query is one line until someone opens it.

import { h } from './ui.js';

const OPEN_UP_TO = 12;    // a list longer than this, or an object with more fields, starts folded
const SHOW_AT_MOST = 50;  // an opened list shows this many items, then says how many more

function leaf(value: unknown): HTMLElement {
  if (typeof value === 'string') return h('span', 's', JSON.stringify(value.length > 200 ? value.slice(0, 199) + '…' : value));
  if (typeof value === 'number' || typeof value === 'boolean') return h('span', 'n', String(value));
  if (value === null || value === undefined) return h('span', 'p', String(value));
  if (typeof value === 'function') return h('span', 'orange-t', 'function');
  return h('span', 'p', String(value));
}

/** `value` under the name `name`, at depth `depth`. */
function node(name: string, value: unknown, depth: number): HTMLElement {
  const indent = { style: `padding-left:${depth * 12}px` };
  const key = name ? [h('span', 'k', name), h('span', 'p', ': ')] : [];
  if (!value || typeof value !== 'object') return h('div', '', [...key, leaf(value)], indent);
  const entries: Array<[string, unknown]> = Array.isArray(value) ? value.map((item, index): [string, unknown] => [String(index), item]) : Object.entries(value);
  const size = Array.isArray(value) ? `${entries.length} items` : `${entries.length} fields`;
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const wrap = h('div', '');
  let opened = entries.length <= OPEN_UP_TO && depth < 3;
  const draw = (): void => {
    const fold = h('button', 'fold', opened ? '▾' : '▸', { type: 'button', 'aria-label': opened ? 'fold' : 'open' });
    fold.addEventListener('click', () => { opened = !opened; draw(); });
    const head = h('div', '', [fold, ...key, h('span', 'p', open + ' '), h('span', 'dim', size), opened ? null : h('span', 'p', ' ' + close)], indent);
    wrap.replaceChildren(head);
    if (!opened) return;
    for (const [child, inner] of entries.slice(0, SHOW_AT_MOST)) wrap.append(node(Array.isArray(value) ? '' : child, inner, depth + 1));
    if (entries.length > SHOW_AT_MOST) wrap.append(h('div', 'dim', `… ${entries.length - SHOW_AT_MOST} more`, { style: `padding-left:${(depth + 1) * 12}px` }));
    wrap.append(h('div', 'p', close, indent));
  };
  draw();
  return wrap;
}

/** `value` as a folding tree (a string that is JSON, like a response body, is read as JSON). */
export function jsonTree(value: unknown, name = ''): HTMLElement {
  let shown = value;
  if (typeof value === 'string' && /^\s*[[{]/.test(value)) { try { shown = JSON.parse(value); } catch { shown = value; } }
  return h('div', 'code', [node(name, shown, 0)]);
}
