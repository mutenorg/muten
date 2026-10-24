// xray: every update outlined on the page as it happens, numbered in its order with its time; a node that redraws
// often turns red. And the last update told step by step: what the person did, what changed, what redrew.

import { record } from './probes.js';
import { h, ms } from './ui.js';
import { nodes, nameOf, placeOf, type TabContext } from './tabs-a.js';

const SHOW_MS = 1200;      // an outline stays this long
const HOT = 5;             // redrawn this many times within HOT_WINDOW: red
const HOT_WINDOW = 2000;

let seen = 0;
let layer: HTMLElement | null = null;

/** Draws the outlines of the redraws recorded since the last call, in `host` (the devtools' shadow root). */
export function paintUpdates(host: ShadowRoot): void {
  if (!layer) { layer = h('div', '', [], { 'aria-hidden': 'true', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147482999' }); host.append(layer); }
  const fresh = record.redraws.slice(seen);
  seen = record.redraws.length;
  const all = nodes();
  fresh.forEach((redraw, index) => {
    const element = all[redraw.node]?.el;
    if (!element || !element.isConnected) return;
    const box = element.getBoundingClientRect();
    if (!box.width && !box.height) return;
    const hot = record.redraws.filter((other) => other.node === redraw.node && redraw.at - other.at < HOT_WINDOW).length >= HOT;
    const color = hot ? '#F28B82' : '#FF5E00';
    const mark = h('div', '', [h('span', '', `${index + 1} · ${ms(redraw.ms)}`, { style: `position:absolute;top:-20px;left:0;background:${color};color:#fff;font:600 11px ui-monospace,monospace;border-radius:5px;padding:1px 6px;white-space:nowrap` })],
      { style: `position:fixed;left:${box.left - 3}px;top:${box.top - 3}px;width:${box.width + 6}px;height:${box.height + 6}px;border:2px solid ${color};border-radius:6px;transition:opacity .3s` });
    layer?.append(mark);
    setTimeout(() => { mark.style.opacity = '0'; setTimeout(() => mark.remove(), 320); }, SHOW_MS);
  });
}

/** Stops drawing (the next start draws only what happens from then on). */
export function stopUpdates(): void { layer?.replaceChildren(); seen = record.redraws.length; }

/** The last update, step by step. */
export function xrayView(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  const moment = [...record.moments].reverse().find((one) => record.redraws.some((redraw) => redraw.moment === one.n));
  if (!moment) { body.append(h('div', 'empty', 'Use the app: every update is outlined on the page, and told here step by step.')); return body; }
  const redraws = record.redraws.filter((redraw) => redraw.moment === moment.n);
  const changes = record.changes.filter((change) => change.moment === moment.n);
  const all = nodes();
  body.append(h('div', 'row between', [h('span', 'strong', 'Last update, step by step'), h('span', 'small dim', `${ms(redraws.reduce((sum, redraw) => sum + redraw.ms, 0))} in all`)]));
  const steps = h('div', 'list');
  steps.append(h('div', 'row', [h('span', 'chip', '1'), h('span', 'small', moment.label)]));
  for (const change of changes.slice(0, 4)) steps.append(h('div', 'row', [h('span', 'chip', '↳'), h('span', 'small', ['state ', h('span', 'mono', change.name), ` ${change.summary}`])]));
  const seenNodes = new Set<string>();
  let n = 1;
  for (const redraw of redraws) {
    if (seenNodes.has(redraw.node) || seenNodes.size >= 8) continue;
    seenNodes.add(redraw.node);
    const rec = all[redraw.node];
    const place = rec ? placeOf(rec) : null;
    n++;
    steps.append(h('div', 'row', [h('span', 'chip red', String(n)), h('span', 'small cut', nameOf(rec)), place ? h('button', 'link', place.part ? `part ${place.part}:${place.line}` : `${place.file?.split('/').pop()}:${place.line}`, { type: 'button' }) : null, h('span', 'spacer'), h('span', 'small dim', ms(redraw.ms))]));
    const link = steps.lastElementChild?.querySelector('button');
    if (link && place) link.addEventListener('click', () => ctx.openSource(place));
  }
  body.append(steps);
  const total = Object.keys(all).length;
  const touched = new Set(redraws.map((redraw) => redraw.node)).size;
  body.append(h('div', 'card green', [h('span', 'small', `${touched} place${touched === 1 ? '' : 's'} redrew; the other ${Math.max(0, total - touched)} elements of the page were not touched`)]));
  body.append(h('span', 'small dim', 'On the page: every update outlines what it redrew, numbered in order, with its time. What redraws often turns red.'));
  return body;
}
