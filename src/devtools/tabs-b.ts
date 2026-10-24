// tabs-b: Profiler (what took the time, moment by moment, and what needs a look), Texts (every language against the
// default, and the keys a person sees bare), Issues (check's findings on this page, errors while running, failed
// requests) and the report to paste to an AI.

import { record, readiness, type Moment } from './probes.js';
import { h, button, ms, kb, ago } from './ui.js';
import { nodes, nameOf, placeOf, pageFile, type TabContext } from './tabs-a.js';
import type { Found } from '#engine/project/place.js';

interface LanguageFacts { code: string; missing: string[]; differs: string[]; same: string[] }
interface TextFacts { base?: string; total?: number; languages: LanguageFacts[] }
interface Weight { at: string; routes: Array<{ url: string; js: number; files: Array<{ file: string; gz: number }> }> }
interface Issues { page: Found[]; elsewhere: number }

const SLOW_MS = 16;          // an update past one frame
const OFTEN = 20;            // redrawn this often in one moment
const SLOW_REQUEST_MS = 1000;
const LANGUAGES_SHOWN = 3;
const ROW_PX = 34;
const BOX_PX = 340;

const asked = new Map<string, Promise<unknown>>();
/** The dev server's answer to `url`, asked once (`fresh` asks again). */
export function ask(url: string, fresh = false): Promise<unknown> {
  if (fresh || !asked.has(url)) asked.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return asked.get(url) || Promise.resolve(null);
}
const isObject = (value: unknown): value is { [key: string]: unknown } => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const answered: { texts?: TextFacts; weight?: Weight | null; issues?: Issues; issuesOf?: string } = {};

// ── Profiler ─────────────────────────────────────────────────────────────────

let chosen = 0;

/** The redraws of moment `n`, by node: how many and how long, slowest first. */
function byNode(n: number): Array<{ node: string; count: number; total: number }> {
  const out = new Map<string, { node: string; count: number; total: number }>();
  for (const redraw of record.redraws) if (redraw.moment === n) { const one = out.get(redraw.node) || { node: redraw.node, count: 0, total: 0 }; one.count++; one.total += redraw.ms; out.set(redraw.node, one); }
  return [...out.values()].sort((a, b) => b.total - a.total);
}

export function profilerToolbar(ctx: TabContext): HTMLElement {
  const moments = record.moments;
  const at = Math.max(0, moments.findIndex((moment) => moment.n === chosen));
  const go = (step: number): void => { const next = moments[Math.min(moments.length - 1, Math.max(0, (chosen ? at : moments.length - 1) + step))]; if (next) { chosen = next.n; ctx.redraw(); } };
  return h('div', 'toolbar', [
    button(record.recording ? 'ibtn rec' : 'ibtn', '●', () => { record.recording = !record.recording; ctx.redraw(); }, { 'aria-label': record.recording ? 'Stop recording' : 'Record', title: record.recording ? 'Stop recording' : 'Record' }),
    button('ibtn', '↻', () => location.reload(), { 'aria-label': 'Reload the page and record its load', title: 'Reload the page and record its load' }),
    button('ibtn', '⌫', () => { record.moments.length = 0; record.redraws.length = 0; record.requests.length = 0; record.changes.length = 0; chosen = 0; ctx.redraw(); }, { 'aria-label': 'Clear the recording', title: 'Clear the recording' }),
    h('span', 'small orange-t', record.recording ? 'recording' : 'paused'),
    h('span', 'spacer'),
    button('ibtn', '‹', () => go(-1), { 'aria-label': 'Previous moment' }),
    h('span', 'small', moments.length ? `${(chosen ? at : moments.length - 1) + 1} of ${moments.length}` : '0 of 0'),
    button('ibtn', '›', () => go(1), { 'aria-label': 'Next moment' }),
  ]);
}

export function profilerTab(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  const moments = record.moments.slice(-60);
  if (!moments.length) { body.append(h('div', 'empty', 'Recording: use the app, or reload to record the load.')); return body; }
  const current: Moment = record.moments.find((moment) => moment.n === chosen) || moments[moments.length - 1];
  const tallest = Math.max(1, ...moments.map((moment) => moment.ms));
  const steps = h('div', 'steps');
  for (const moment of moments) {
    const slow = byNode(moment.n).some((one) => one.total > SLOW_MS) || moment.ms > SLOW_REQUEST_MS;
    const bar = button(moment === current ? 'on' : '', '', () => { chosen = moment.n; ctx.redraw(); }, { 'aria-label': `${moment.label}, ${ms(moment.ms)}`, title: `${moment.label} · ${ms(moment.ms)}` });
    bar.setAttribute('style', `height:${Math.max(3, (moment.ms / tallest) * 44)}px;background:${slow ? '#F28B82' : moment.kind === 'load' ? '#E8B95C' : '#7BD88F'}`);
    steps.append(bar);
  }
  body.append(steps, h('div', 'row between', [h('span', 'strong', current.label), h('span', 'small dim', ms(current.ms))]));
  const requests = record.requests.filter((request) => request.moment === current.n);
  const drawn = byNode(current.n);
  const longest = Math.max(1, ...requests.map((request) => request.ms), ...drawn.map((one) => one.total));
  const line = (label: string, value: number, color: string): HTMLElement => h('div', 'row', [h('span', 'mono cut', label), h('span', 'spacer'), h('span', 'hbar', '', { style: `width:${Math.max(2, (value / longest) * 140)}px;background:${color}` }), h('span', 'small dim', ms(value))]);
  for (const request of requests.slice(0, 4)) body.append(line(`${request.method} ${request.url.replace(location.origin, '')}`, request.ms, '#5B8DEF'));
  for (const one of drawn.slice(0, 5)) body.append(line(`${one.count > 1 ? one.count + ' × ' : ''}${nameOf(nodes()[one.node])}`, one.total, one.total > SLOW_MS ? '#F28B82' : '#7BD88F'));
  if (!requests.length && !drawn.length) body.append(h('span', 'small dim', 'nothing ran in this moment'));
  const look = drawn.find((one) => one.total > SLOW_MS || one.count > OFTEN);
  const slowRequest = requests.find((request) => request.ms > SLOW_REQUEST_MS);
  if (look || slowRequest) {
    const rec = look ? nodes()[look.node] : undefined;
    const place = rec ? placeOf(rec) : null;
    body.append(h('div', 'card amber', [
      h('span', 'label amber-t', 'Needs a look'),
      look ? h('span', 'small', `${nameOf(rec)} redrew ${look.count} time${look.count === 1 ? '' : 's'}, ${ms(look.total)} in all${look.count > OFTEN ? ': something it reads changes very often' : ': past one frame'}`) : null,
      place ? button('link', place.part ? `part ${place.part}:${place.line}` : `${place.file}:${place.line}`, () => ctx.openSource(place)) : null,
      slowRequest ? h('span', 'small', `${slowRequest.method} ${slowRequest.url.replace(location.origin, '')} took ${ms(slowRequest.ms)}`) : null,
    ]));
  }
  const ready = readiness();
  if (ready) body.append(h('span', 'small dim', `ready to use in ${ms(ready.ms)} (from the open to the page mounted)`));
  if (answered.weight === undefined) void ask('/_muten/weight').then((value) => { answered.weight = isObject(value) && Array.isArray(value.routes) ? { at: String(value.at), routes: value.routes.filter(isObject).map((route) => ({ url: String(route.url), js: Number(route.js), files: [] })) } : null; ctx.redraw(); });
  const route = answered.weight?.routes.find((one) => one.url === location.pathname);
  body.append(h('span', 'small dim', route ? `JS this route ships: ${kb(route.js)} gzipped · from your last muten bundle, ${new Date(answered.weight?.at || '').toLocaleTimeString()}` : 'JS this route ships: run muten bundle to measure it (dev code is not what ships)'));
  return body;
}

// ── Texts ────────────────────────────────────────────────────────────────────

let allLanguages = false, seeAll = false, filter = '', only = '';

function virtualList(keys: Array<{ key: string; languages: string[] }>): HTMLElement {
  const box = h('div', '', [], { style: `height:${BOX_PX}px;overflow:auto;border:1px solid #2A2B30;border-radius:10px;position:relative` });
  const inner = h('div', '', [], { style: `height:${keys.length * ROW_PX}px;position:relative` });
  box.append(inner);
  const paint = (): void => {
    const first = Math.floor(box.scrollTop / ROW_PX), last = Math.min(keys.length, first + Math.ceil(BOX_PX / ROW_PX) + 2);
    inner.replaceChildren(...keys.slice(first, last).map((one, index) => h('div', 'row', [h('span', 'mono cut', one.key), h('span', 'spacer'), ...one.languages.map((code) => h('span', 'chip red', code))], { style: `position:absolute;left:0;right:0;top:${(first + index) * ROW_PX}px;height:${ROW_PX}px;padding:0 10px;align-items:center;border-bottom:1px solid #222327` })));
  };
  box.addEventListener('scroll', paint);
  paint();
  return box;
}

export function textsTab(ctx: TabContext): HTMLElement {
  const body = h('div', 'list');
  if (!answered.texts) { void ask('/_muten/texts').then((value) => { answered.texts = isObject(value) && Array.isArray(value.languages) ? { base: String(value.base || ''), total: Number(value.total || 0), languages: value.languages.filter(isObject).map((one) => ({ code: String(one.code), missing: Array.isArray(one.missing) ? one.missing.map(String) : [], differs: Array.isArray(one.differs) ? one.differs.map(String) : [], same: Array.isArray(one.same) ? one.same.map(String) : [] })) } : { languages: [] }; ctx.redraw(); }); body.append(h('div', 'empty', 'Reading src/lang…')); return body; }
  const facts = answered.texts;
  if (!facts.languages.length) { body.append(h('div', 'empty', 'This app has no src/lang files: its texts are written in the pages (or come from its own t()).')); return body; }
  const missingKeys = new Map<string, string[]>();
  for (const language of facts.languages) for (const key of language.missing) missingKeys.set(key, [...(missingKeys.get(key) || []), language.code]);
  const rows = [...missingKeys.entries()].map(([key, languages]) => ({ key, languages }));
  if (seeAll) {
    const search = h('input', '', [], { placeholder: 'Search a key…', 'aria-label': 'Search keys', value: filter });
    search.addEventListener('input', () => { filter = search instanceof HTMLInputElement ? search.value : ''; ctx.redraw(); });
    const chips = h('div', 'row wrap', [button(only ? 'btn' : 'btn on', `All ${rows.length}`, () => { only = ''; ctx.redraw(); }), ...facts.languages.filter((one) => one.missing.length).map((one) => button(only === one.code ? 'btn on' : 'btn', `${one.code} ${one.missing.length}`, () => { only = one.code; ctx.redraw(); }))]);
    const shown = rows.filter((row) => (!filter || row.key.includes(filter)) && (!only || row.languages.includes(only)));
    body.append(button('link', '‹ Texts', () => { seeAll = false; ctx.redraw(); }), search, chips, virtualList(shown), h('span', 'small dim', `${shown.length} keys · only the rows in view are drawn`));
    return body;
  }
  const langNow = window.__muten_rt ? Reflect.get(window.__muten_rt, '__lang') : undefined;
  const current: unknown = typeof langNow === 'function' ? Reflect.apply(langNow, window.__muten_rt, []) : '';
  const select = h('select', '', facts.languages.map((one) => h('option', '', one.code, one.code === current ? { value: one.code, selected: '' } : { value: one.code })), { 'aria-label': 'Preview language' });
  select.addEventListener('change', () => { const use = window.__muten_rt ? Reflect.get(window.__muten_rt, '__langUse') : undefined; if (typeof use === 'function' && select instanceof HTMLSelectElement) Reflect.apply(use, window.__muten_rt, [select.value]); });
  body.append(h('div', 'row between', [h('label', 'row small dim', ['Preview in ', select]), h('span', 'small dim', `${facts.languages.length} languages · default ${facts.base}`)]));
  const ranked = [...facts.languages].sort((a, b) => b.missing.length - a.missing.length);
  body.append(h('span', 'label', 'Need it most'));
  for (const language of allLanguages ? ranked : ranked.slice(0, LANGUAGES_SHOWN)) {
    const pct = facts.total ? Math.round(100 * (1 - language.missing.length / facts.total)) : 100;
    body.append(h('div', 'row', [h('span', 'mono', language.code), h('div', 'bar', [h('i', '', [], { style: `width:${pct}%;background:${pct === 100 ? '#7BD88F' : pct > 90 ? '#E8B95C' : '#F28B82'}` })], { style: 'flex:1' }), h('span', 'small', language.missing.length ? `${language.missing.length} missing` : 'complete')]));
  }
  if (!allLanguages && ranked.length > LANGUAGES_SHOWN) body.append(button('link', `+ ${ranked.length - LANGUAGES_SHOWN} more languages, ${ranked.slice(LANGUAGES_SHOWN).filter((one) => !one.missing.length).length} complete · see all`, () => { allLanguages = true; ctx.redraw(); }));
  const bare = [...record.missing.values()].filter((one) => one.bare);
  for (const one of bare.slice(0, 2)) body.append(h('div', 'card red', [h('span', 'label red-t', 'On screen as a bare key'), h('div', 'row wrap', [h('span', 'mono', one.key), h('span', 'small dim', 'in'), h('span', 'chip red', one.language)])]));
  const borrowed = [...record.missing.values()].filter((one) => !one.bare);
  for (const one of borrowed.slice(0, 2)) body.append(h('div', 'card amber', [h('span', 'label amber-t', 'On screen in another language'), h('div', 'row wrap', [h('span', 'mono', one.key), h('span', 'small dim', 'has no text in'), h('span', 'chip red', one.language), h('span', 'small dim', 'so another language\'s shows')])]));
  body.append(h('div', 'row between', [h('span', 'label', `Missing · ${rows.length}`), rows.length ? button('link', `See all ${rows.length}`, () => { seeAll = true; ctx.redraw(); }) : null]));
  for (const row of rows.slice(0, 2)) body.append(h('div', 'row', [h('span', 'mono cut', row.key), h('span', 'spacer'), ...row.languages.slice(0, 3).map((code) => h('span', 'chip red', code)), row.languages.length > 3 ? h('span', 'small dim', `+ ${row.languages.length - 3}`) : null]));
  const differs = facts.languages.reduce((sum, one) => sum + one.differs.length, 0), same = facts.languages.reduce((sum, one) => sum + one.same.length, 0);
  if (differs || same) body.append(h('div', 'card', [h('span', 'small', `${differs} not the same values · ${same} the same text as ${facts.base} (never translated?)`)]));
  return body;
}

// ── Issues ───────────────────────────────────────────────────────────────────

const placed = new Map<string, string>();

/** The count on the Issues tab: findings that are errors, errors while running, failed requests. */
export function issueCount(): number {
  return (answered.issues?.page.filter((found) => found.severity === 'error').length || 0) + record.faults.length + record.requests.filter((request) => !request.ok).length;
}

/** Asks the dev server for the findings of the page on screen (once per page; not before the page is known). */
export function loadIssues(redraw: () => void): void {
  const screen = window.__muten_screen || '';
  if (!screen || answered.issuesOf === screen) return;
  answered.issuesOf = screen;
  void ask(`/_muten/issues?screen=${encodeURIComponent(screen)}`, true).then((value) => {
    answered.issues = isObject(value) && Array.isArray(value.page) ? { page: value.page.filter(isObject).map((found) => ({ file: String(found.file), code: String(found.code), severity: found.severity === 'warning' ? 'warning' : 'error', message: String(found.message), loc: isObject(found.loc) ? { line: Number(found.loc.line), col: Number(found.loc.col) } : null, suggestion: typeof found.suggestion === 'string' ? found.suggestion : null, fix: isObject(found.fix) ? { from: String(found.fix.from), to: String(found.fix.to) } : null })), elsewhere: Number(value.elsewhere || 0) } : { page: [], elsewhere: 0 };
    redraw();
  });
}

export function issuesTab(ctx: TabContext, applyFix: (found: Found) => void): HTMLElement {
  const body = h('div', 'list');
  loadIssues(ctx.redraw);
  for (const fault of record.faults.slice(-2).reverse()) {
    if (!placed.has(fault.text)) { placed.set(fault.text, fault.text.split('\n')[0]); void fetch('/_muten/error', { method: 'POST', headers: { 'x-muten-token': window.__MUTEN_DEV_TOKEN || '', 'content-type': 'application/json' }, body: JSON.stringify({ stack: fault.text }) }).then((r) => r.json()).then((answer: unknown) => { if (isObject(answer) && typeof answer.text === 'string') { placed.set(fault.text, answer.text); ctx.redraw(); } }).catch(() => {}); }
    body.append(h('div', 'card red', [h('div', 'row between', [h('span', 'label red-t', 'Broke while running'), h('span', 'small dim', ago(fault.at))]), h('div', 'code', placed.get(fault.text) || fault.text)]));
  }
  const failed = record.requests.filter((request) => !request.ok);
  if (failed.length) body.append(h('div', 'card red', [h('span', 'small', `${failed.length} request${failed.length === 1 ? '' : 's'} failed on this page · see Data`)]));
  const findings = answered.issues?.page || [];
  for (const found of findings.slice(0, 6)) body.append(h('div', 'card', [
    h('div', 'row between', [h('span', found.severity === 'error' ? 'label red-t' : 'label amber-t', `${found.code} · ${found.severity}`), h('span', 'mono dim', `${found.file.split('/').pop()}:${found.loc?.line ?? ''}`)]),
    h('span', 'small', found.message),
    h('div', 'row wrap', [found.fix ? button('btn primary', `Fix: ${found.fix.from} → ${found.fix.to}`, () => applyFix(found)) : null, found.loc ? button('link', 'Open the line', () => ctx.openSource({ file: found.file, line: found.loc?.line || 1 })) : null]),
  ]));
  if (findings.length > 6) body.append(h('span', 'small dim', `+ ${findings.length - 6} more on this page · muten check shows them all`));
  if (!answered.issues) body.append(h('div', 'empty', 'Reading muten check…'));
  if (answered.issues && !findings.length && !record.faults.length && !failed.length) body.append(h('div', 'card green', [h('span', 'small', `Nothing wrong on this page${answered.issues.elsewhere ? ` · ${answered.issues.elsewhere} elsewhere in the app` : ''}`)]));
  return body;
}

// ── Copy for AI ──────────────────────────────────────────────────────────────

/** What Claude needs to help, in one paste. */
export function report(picked: string): string {
  const lines = [`muten app · page ${window.__muten_screen || ''} (${location.pathname}) · ${pageFile()}`];
  const rec = nodes()[picked];
  if (rec) { const place = placeOf(rec); lines.push('', `Picked: ${nameOf(rec)}${place ? ` at ${place.part ? 'part ' + place.part : place.file}:${place.line}` : ''}`); }
  const fault = record.faults[record.faults.length - 1];
  if (fault) lines.push('', 'Broke while running:', (placed.get(fault.text) || fault.text).split('\n').slice(0, 6).join('\n'));
  const failed = record.requests.filter((request) => !request.ok).slice(-3);
  if (failed.length) lines.push('', 'Failed requests:', ...failed.map((request) => `  ${request.method} ${request.url} → ${request.status || 'no answer'}${request.action ? ' (action ' + request.action + ')' : ''} ${request.body.slice(0, 200)}`));
  const moments = record.moments.slice(-5);
  if (moments.length) lines.push('', 'Last changes:', ...moments.map((moment, index) => `  ${index + 1}. ${moment.label}${record.changes.filter((change) => change.moment === moment.n).map((change) => ` · ${change.name} ${change.summary}`).join('')}`));
  const findings = answered.issues?.page || [];
  if (findings.length) lines.push('', "What's wrong (muten check):", ...findings.slice(0, 8).map((found) => `  ${found.file}:${found.loc?.line ?? ''} ${found.code}  ${found.message}`));
  return lines.join('\n');
}
