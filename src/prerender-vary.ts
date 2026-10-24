// prerender-vary: a written-out copy never shows what a script laid out for another screen. The copy is drawn on one
// screen; a component that measures (Storio's bar: each piece's position and width, `data-ready`, `data-compact`)
// leaves values that are that screen's only, and on any other width the copy showed the bar taken apart until the
// app measured again. Putting values back cannot work: what a script sets while the page mounts is, for muten,
// indistinguishable from what the page was built with. What can be known: the drawing already lays the page out on a
// desktop screen and on a phone's (for its pictures), and an element whose attributes differ between the two was
// laid out by a script. In the copy it keeps its place but is not shown (`data-muten-measured`, made transparent by
// the copy's inline CSS) until the app is up and has measured it on the reader's own screen. An element that is the
// same on both screens shows: a bar laid out by CSS alone is in the copy.
const KEY = 'data-muten-k';
export const MEASURED = 'data-muten-measured';
/** The copy's rule for it (prerender.ts puts it in the page's inline CSS). Opacity, not visibility: a child with its
 *  own `visibility: visible` showed through a hidden parent; none can be more opaque than its parent. */
export const HIDE_MEASURED = `#app>[data-muten-snap] [${MEASURED}]{opacity:0!important;pointer-events:none}`;

/** Gives every element of #app a key (runs in the page), so the two readings can be matched element by element. */
export const KEY_ELEMENTS = `(() => { let next = 0; for (const el of document.querySelectorAll('#app *')) if (!el.hasAttribute('${KEY}')) el.setAttribute('${KEY}', String(++next)); return next; })()`;

/** Every keyed element's attributes (runs in the page): what a picture's loading changes is left out. */
export const READ_ATTRIBUTES = `(() => {
  const skip = new Set(['${KEY}', 'data-shown', 'data-state']);
  const out = {};
  for (const el of document.querySelectorAll('[${KEY}]')) {
    const attrs = {};
    for (const attr of el.attributes) if (!skip.has(attr.name)) attrs[attr.name] = attr.value;
    out[el.getAttribute('${KEY}')] = attrs;
  }
  return out;
})()`;

interface Attributes { [name: string]: string }
interface Reading { [key: string]: Attributes }

const same = (one: Attributes, other: Attributes): boolean => {
  const names = new Set([...Object.keys(one), ...Object.keys(other)]);
  for (const name of names) if ((one[name] ?? null) !== (other[name] ?? null)) return false;
  return true;
};

/** The script (runs in the page) that marks every element laid out differently on the two screens. */
export function markMeasured(drawnOn: Reading, other: Reading): string {
  const keys = Object.keys(drawnOn).filter((key) => other[key] && !same(drawnOn[key], other[key]));
  return `(() => { for (const key of ${JSON.stringify(keys)}) document.querySelector('[${KEY}="' + key + '"]')?.setAttribute('${MEASURED}', ''); return ${keys.length}; })()`;
}

/** In the copy (runs in the page, on the clone): the keys go; the marks stay, for the copy's CSS. */
export const UNKEY_COPY = `(copy) => { for (const el of copy.querySelectorAll('[${KEY}]')) el.removeAttribute('${KEY}'); }`;

/** Takes keys and marks off the live page (runs in the page), once the copy is taken. */
export const UNMARK = `(() => { for (const el of document.querySelectorAll('[${KEY}], [${MEASURED}]')) { el.removeAttribute('${KEY}'); el.removeAttribute('${MEASURED}'); } return true; })()`;

/** A reading as the page returned it: element key → attribute name → value. */
export function asReading(value: unknown): Reading {
  const out: Reading = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, attrs] of Object.entries(value)) {
    if (!attrs || typeof attrs !== 'object') continue;
    const clean: Attributes = {};
    for (const [name, text] of Object.entries(attrs)) if (typeof text === 'string') clean[name] = text;
    out[key] = clean;
  }
  return out;
}
