// tabs-a: Inspect (what is this element, where is it written, what was it given, what it reads, how often it redraws), Timeline (what
// happened, in words, moment by moment) and Data (every request, the failed ones first, and the ones asked twice).

import { record, short, type Moment } from './probes.js';
import { h, button, ms, ago } from './ui.js';
import { jsonTree } from './json.js';   // a failed answer's body, read as JSON
import type { MountedNode } from '#engine/shared/types-tooling.js';

/** What a tab needs from the panel. */
export interface TabContext { redraw: () => void; openSource: (place: Place) => void; picked: string; pick: (id: string) => void; picking: boolean; setPicking: (on: boolean) => void }
/** A line of the app's source: a page's file, or a part (found by its name). */
export interface Place { file?: string; part?: string; line: number }

const TIMELINE_SHOWN = 12;
const REQUESTS_SHOWN = 8;
const TWICE_MS = 1000;

/** The node registry of the page on screen. */
export const nodes = (): { [id: string]: MountedNode } => window.__muten_page?.nodes || {};
/** The page file of the screen on show. */
export const pageFile = (): string => { const screen = window.__muten_screen || ''; return `src/pages/${screen}/${screen}.muten`; };
/** A node's name as written: its part, else its primitive. */
export const nameOf = (rec: MountedNode | undefined): string => rec?.part || rec?.type || 'element';

/** Where node `rec` is written: in its part's file, or in the page. */
export function placeOf(rec: MountedNode): Place | null {
  if (rec.owner && rec.oloc) return { part: rec.owner, line: rec.oloc.line };
  return rec.loc ? { file: pageFile(), line: rec.loc.line } : null;
}
const placeText = (place: Place): string => (place.part ? `part ${place.part}:${place.line}` : `${place.file}:${place.line}`);

/** A place as a link that opens it in the editor. */
function sourceLink(ctx: TabContext, place: Place | null): HTMLElement {
  if (!place) return h('span', 'dim small', 'no line (made by muten)');
  return h('span', 'row wrap', [h('span', 'chip', placeText(place)), button('link', 'Open in editor', () => ctx.openSource(place))]);
}

// ── Inspect ──────────────────────────────────────────────────────────────────

/** The value a node reads, right now: a page state or get (`items`), or a store's (`cart.total`). */
function valueOf(name: string): string {
  const [head, field] = name.split('.');
  const page = window.__muten_page?.ctx || {};
  const store = field ? (window.__muten_stores || {})[head] : undefined;
  const ref: unknown = store ? Reflect.get(store, field) : Reflect.get(page, head);
  const get = ref && typeof ref === 'object' ? Reflect.get(ref, 'get') : undefined;
  if (typeof get !== 'function') return '';
  const value: unknown = Reflect.apply(get, ref, []);
  const inner = !store && field && value && typeof value === 'object' ? Reflect.get(value, field) : value;   // `items.length`, `user.name`
  return short(inner);
}

export function inspectTab(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  const all = nodes();
  const rec = all[ctx.picked];
  body.append(h('div', 'row between', [
    h('span', 'small dim', ctx.picking ? 'Click anything in the app…' : 'Pick an element to see where it is written'),
    button(ctx.picking ? 'btn on' : 'btn', ctx.picking ? 'Picking' : 'Pick', () => ctx.setPicking(!ctx.picking)),
  ]));
  if (!rec) { body.append(h('div', 'empty', 'Nothing picked yet.')); return body; }
  const place = placeOf(rec);
  body.append(h('div', 'list', [
    h('span', 'label', 'You picked'),
    h('div', 'row', [h('span', 'big', nameOf(rec)), h('span', 'small dim', rec.part ? 'a part' : 'an element')]),
    sourceLink(ctx, place),
    rec.part && rec.loc ? h('span', 'small dim', [`called at `, h('span', 'mono', `${pageFile()}:${rec.loc.line}`)]) : null,
  ]));
  if (rec.partArgs && Object.keys(rec.partArgs).length) body.append(h('div', 'list', [h('span', 'label', 'It was called with'), h('div', 'code', Object.entries(rec.partArgs).map(([name, given]) => h('div', '', [h('span', 'k', name), h('span', 'p', ': '), h('span', '', given)])))]));
  // what it reads: the states, gets and store values it redraws with (the compiler wrote them down: reads.ts)
  if (rec.reads?.length) body.append(h('div', 'list', [h('span', 'label', 'It reads'), h('div', 'code', rec.reads.map((name) => h('div', '', [h('span', 'k', name), h('span', 'p', ' = '), h('span', '', valueOf(name) || '…')])))]));
  const mine = record.redraws.filter((redraw) => redraw.node === ctx.picked);
  const total = mine.reduce((sum, redraw) => sum + redraw.ms, 0);
  body.append(h('div', 'list', [
    h('span', 'label', 'Redraws'),
    h('span', 'small', mine.length ? `${mine.length} time${mine.length === 1 ? '' : 's'} since the page opened · ${ms(total)} in all · last ${ago(mine[mine.length - 1].at)}` : 'not redrawn since the page opened'),
  ]));
  const classes = rec.el instanceof HTMLElement || rec.el instanceof SVGElement ? rec.el.getAttribute('class') || '' : '';
  if (classes) body.append(h('div', 'list', [h('span', 'label', 'Styled by'), h('span', 'mono', classes)]));
  return body;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

let timelineAll = false;
let selectedMoment = 0;

/** One moment's changes in a line: «services +1 · draft → {} · saving true → false». */
const changesOf = (moment: Moment): string => record.changes.filter((change) => change.moment === moment.n).map((change) => `${change.name} ${change.summary}`).join(' · ');

export function timelineTab(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  const moments = [...record.moments].reverse();
  if (!moments.length) { body.append(h('div', 'empty', 'Nothing yet: use the app and each thing you do shows here.')); return body; }
  const shown = timelineAll ? moments : moments.slice(0, TIMELINE_SHOWN);
  const current = moments.find((moment) => moment.n === selectedMoment) || moments[0];
  for (const moment of shown) {
    const item = h('button', moment === current ? 'item on' : 'item', [
      h('div', 'row between small dim', [h('span', '', `${ago(moment.at)} · ${moment.label}`), h('span', '', moment.ms ? ms(moment.ms) : '')]),
      h('span', 'small cut', changesOf(moment) || (moment.kind === 'load' ? 'the page opened' : 'nothing changed')),
    ], { type: 'button' });
    item.addEventListener('click', () => { selectedMoment = moment.n; ctx.redraw(); });
    body.append(item);
  }
  if (!timelineAll && moments.length > TIMELINE_SHOWN) body.append(button('link', `+ ${moments.length - TIMELINE_SHOWN} older · see all`, () => { timelineAll = true; ctx.redraw(); }));
  const changes = record.changes.filter((change) => change.moment === current.n);
  const requests = record.requests.filter((request) => request.moment === current.n);
  const redraws = record.redraws.filter((redraw) => redraw.moment === current.n);
  body.append(h('div', 'card', [
    h('span', 'label', `${current.label} changed`),
    changes.length ? h('div', 'list', changes.map((change) => h('span', 'mono', `${change.name}  ${change.summary}`))) : h('span', 'small dim', 'no state changed'),
    requests.length ? h('span', 'small dim', `${requests.length} request${requests.length === 1 ? '' : 's'} · ${requests.filter((request) => !request.ok).length} failed`) : null,
    h('span', 'small dim', `${redraws.length} redraw${redraws.length === 1 ? '' : 's'} · ${ms(redraws.reduce((sum, redraw) => sum + redraw.ms, 0))}`),
  ]));
  return body;
}

// ── Data ─────────────────────────────────────────────────────────────────────

let dataAll = false;

const path = (url: string): string => { try { const parsed = new URL(url, location.href); return parsed.origin === location.origin ? parsed.pathname + parsed.search : parsed.host + parsed.pathname; } catch { return url; } };

export function dataTab(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  const requests = [...record.requests].reverse();
  if (!requests.length) { body.append(h('div', 'empty', 'No request yet on this page.')); return body; }
  for (const failed of requests.filter((request) => !request.ok).slice(0, 3)) {
    body.append(h('div', 'card red', [
      h('div', 'row between', [h('span', 'label red-t', failed.status ? `Failed · ${failed.status}` : 'Failed · no answer'), h('span', 'small dim', `${ago(failed.at)} · ${ms(failed.ms)}`)]),
      h('span', 'mono', `${failed.method} ${path(failed.url)}`),
      failed.body ? jsonTree(failed.body) : null,
      failed.action ? h('span', 'small', ['sent by action ', h('span', 'mono orange-t', failed.action)]) : h('span', 'small dim', 'sent outside an action (a page load, a function)'),
    ]));
  }
  for (const page of requests.filter((request) => request.html).slice(0, 2)) body.append(h('div', 'card amber', [
    h('div', 'row between', [h('span', 'mono cut', `${page.method} ${path(page.url)}`), h('span', 'small amber-t', 'answered with a web page')]),
    h('span', 'small', 'asked for data and got HTML: nothing answers at this address (the app points at the wrong API?), so the page shows nothing'),
  ]));
  const twice = requests.filter((request, index) => requests.some((other, at) => at !== index && other.method === request.method && other.url === request.url && Math.abs(other.at - request.at) < TWICE_MS));
  const twiceKeys = [...new Set(twice.map((request) => `${request.method} ${path(request.url)}`))];
  for (const key of twiceKeys.slice(0, 2)) body.append(h('div', 'card amber', [h('div', 'row between', [h('span', 'mono', key), h('span', 'small amber-t', 'asked twice in under 1 s')]), h('span', 'small dim', 'two parts of the page ask the same thing: one store query would ask once')]));
  body.append(h('span', 'label', `Requests · ${requests.length}`));
  const shown = dataAll ? requests : requests.slice(0, REQUESTS_SHOWN);
  for (const request of shown) body.append(h('div', 'card', [
    h('div', 'row between', [h('span', 'mono cut', `${request.method} ${path(request.url)}`), h('span', request.ok ? 'small green-t' : 'small red-t', `${request.status || 'failed'} · ${ms(request.ms)}`)]),
    h('span', 'small dim', `${ago(request.at)}${request.action ? ' · action ' + request.action : ''}`),
  ]));
  if (!dataAll && requests.length > REQUESTS_SHOWN) body.append(button('link', `+ ${requests.length - REQUESTS_SHOWN} more requests · see all`, () => { dataAll = true; ctx.redraw(); }));
  return body;
}
