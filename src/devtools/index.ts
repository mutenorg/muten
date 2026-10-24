// devtools: what `muten dev` shows beside the app, on by default (`dev { devtools false }` turns it off), never in a
// build. One floating panel, one row of tabs, each answering one question: Inspect (what is this?), Timeline (what
// happened?), Data (what was asked, what failed?), Profiler (what is slow?), Texts (what does a language lack?),
// Issues (what is wrong?), plus X-ray on the page and a report to paste to an AI. What they show is recorded by the
// runtime where it happens (probes.ts), not guessed from outside.

import { record, startProbes } from './probes.js';
import { CSS, h, button } from './ui.js';
import { inspectTab, timelineTab, dataTab, nodes, type TabContext, type Place } from './tabs-a.js';
import { profilerTab, profilerToolbar, textsTab, issuesTab, issueCount, report, loadIssues } from './tabs-b.js';
import { paintUpdates, stopUpdates, xrayView } from './xray.js';
import type { Found } from '#engine/project/place.js';

const TABS = ['Inspect', 'Timeline', 'Data', 'Profiler', 'Texts', 'Issues'];
const STORE = 'muten:devtools';
const REFRESH_MS = 500;

interface Saved { open: boolean; tab: string; x: number | null; y: number | null }
function saved(): Saved {
  try { const value: unknown = JSON.parse(localStorage.getItem(STORE) || '{}'); if (value && typeof value === 'object') return { open: Reflect.get(value, 'open') !== false, tab: String(Reflect.get(value, 'tab') || 'Issues'), x: typeof Reflect.get(value, 'x') === 'number' ? Number(Reflect.get(value, 'x')) : null, y: typeof Reflect.get(value, 'y') === 'number' ? Number(Reflect.get(value, 'y')) : null }; } catch { /* storage closed */ }
  return { open: true, tab: 'Issues', x: null, y: null };
}
const keep = (state: Saved): void => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage closed */ } };

const post = (url: string): Promise<Response> => fetch(url, { method: 'POST', headers: { 'x-muten-token': window.__MUTEN_DEV_TOKEN || '' } });

export function mountDevtools(): void {
  if (window.__mutenDevtoolsMounted) return;
  window.__mutenDevtoolsMounted = true;
  startProbes();
  const state = saved();
  const host = h('div', '', [], { id: 'muten-devtools-host' });
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', '', CSS));

  let picked = '', picking = false, xray = false, copied = false;
  const panel = h('section', 'panel', [], { 'aria-label': 'muten devtools' });
  const launcher = button('launcher', '', () => setOpen(true), { 'aria-label': 'Open the muten devtools' });
  launcher.append(h('span', 'logo', 'm'), 'devtools');
  shadow.append(panel, launcher);
  if (state.x !== null && state.y !== null) panel.setAttribute('style', `left:${state.x}px;top:${state.y}px;right:auto;bottom:auto;height:min(752px,calc(100vh - 48px))`);

  const outline = h('div', '', [], { 'aria-hidden': 'true', style: 'position:fixed;pointer-events:none;border:2px solid #FF5E00;border-radius:6px;display:none;z-index:2147482998' });
  shadow.append(outline);
  const show = (element: Element | undefined): void => {
    if (!element) { outline.style.display = 'none'; return; }
    const box = element.getBoundingClientRect();
    outline.setAttribute('style', `position:fixed;pointer-events:none;border:2px solid #FF5E00;border-radius:6px;z-index:2147482998;left:${box.left - 3}px;top:${box.top - 3}px;width:${box.width + 6}px;height:${box.height + 6}px`);
  };
  const idAt = (target: EventTarget | null): string => {
    const byElement = new Map<Element, string>(Object.entries(nodes()).map(([id, rec]): [Element, string] => [rec.el, id]));
    for (let at = target instanceof Element ? target : null; at; at = at.parentElement) { const id = byElement.get(at); if (id) return id; }
    return '';
  };
  const onMove = (event: MouseEvent): void => { show(nodes()[idAt(event.target)]?.el); };
  const onPick = (event: MouseEvent): void => { if (event.target === host) return; event.preventDefault(); event.stopPropagation(); picked = idAt(event.target); setPicking(false); show(nodes()[picked]?.el); paint(); };
  function setPicking(on: boolean): void {
    picking = on;
    if (on) { document.addEventListener('mousemove', onMove, true); document.addEventListener('click', onPick, true); }
    else { document.removeEventListener('mousemove', onMove, true); document.removeEventListener('click', onPick, true); }
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    paint();
  }

  const openSource = (place: Place): void => { void post(`/__muten_open?${place.part ? 'part=' + encodeURIComponent(place.part) : 'file=' + encodeURIComponent(place.file || '')}&line=${place.line}`).catch(() => {}); };
  const applyFix = (found: Found): void => {
    if (!found.fix || !found.loc) return;
    void post(`/_muten/fix?file=${encodeURIComponent(found.file)}&line=${found.loc.line}&col=${found.loc.col}&from=${encodeURIComponent(found.fix.from)}&to=${encodeURIComponent(found.fix.to)}`).catch(() => {});
  };
  const ctx = (): TabContext => ({ redraw: paint, openSource, picked, pick: (id) => { picked = id; paint(); }, picking, setPicking });

  function setOpen(open: boolean): void { state.open = open; keep(state); panel.hidden = !open; launcher.hidden = open; if (!open) setPicking(false); paint(); }

  // the head moves the panel; where it was left is where it opens
  let drag: { dx: number; dy: number } | null = null;
  const onDrag = (event: PointerEvent): void => {
    if (!drag) return;
    state.x = Math.max(0, Math.min(innerWidth - 120, event.clientX - drag.dx));
    state.y = Math.max(0, Math.min(innerHeight - 60, event.clientY - drag.dy));
    panel.setAttribute('style', `left:${state.x}px;top:${state.y}px;right:auto;bottom:auto;height:min(752px,calc(100vh - 48px))`);
  };
  const endDrag = (): void => { if (drag) keep(state); drag = null; window.removeEventListener('pointermove', onDrag); };

  let painted = -1;
  function paint(): void {
    painted = record.version;
    const count = issueCount();
    const head = h('div', 'head', [
      h('span', 'grip', '⋮⋮', { 'aria-hidden': 'true' }), h('span', 'logo', 'm'),
      h('span', 'screen', window.__muten_screen || 'page'), h('span', 'path', location.pathname), h('span', 'spacer'),
      button(xray ? 'btn on' : 'btn', xray ? 'X-ray on' : 'X-ray', () => { xray = !xray; if (!xray) stopUpdates(); paint(); }, { 'aria-pressed': String(xray) }),
      button('btn', copied ? 'Copied' : 'Copy for AI', () => { void navigator.clipboard.writeText(report(picked)).then(() => { copied = true; paint(); setTimeout(() => { copied = false; paint(); }, 1500); }); }),
      button('close', '✕', () => setOpen(false), { 'aria-label': 'Close the devtools' }),
    ]);
    head.addEventListener('pointerdown', (event) => {
      if (event.target instanceof HTMLButtonElement) return;
      const box = panel.getBoundingClientRect();
      drag = { dx: event.clientX - box.left, dy: event.clientY - box.top };
      window.addEventListener('pointermove', onDrag);
      window.addEventListener('pointerup', endDrag, { once: true });
    });
    const tabs = h('div', 'tabs', [], { role: 'tablist', 'aria-label': 'Devtools' });
    for (const tab of TABS) {
      const on = !xray && state.tab === tab;
      const badge = tab === 'Issues' && count ? h('span', 'badge', String(count)) : tab === 'Texts' && record.missing.size ? h('span', 'badge amber', String(record.missing.size)) : null;
      const node = button(on ? 'tab on' : 'tab', tab, () => { xray = false; stopUpdates(); state.tab = tab; keep(state); paint(); }, { role: 'tab', 'aria-selected': String(on) });
      if (badge) node.append(badge);
      tabs.append(node);
    }
    const c = ctx();
    const content = xray ? xrayView(c) : state.tab === 'Inspect' ? inspectTab(c) : state.tab === 'Timeline' ? timelineTab(c) : state.tab === 'Data' ? dataTab(c) : state.tab === 'Profiler' ? profilerTab(c) : state.tab === 'Texts' ? textsTab(c) : issuesTab(c, applyFix);
    const scroll = panel.querySelector('.body')?.scrollTop || 0;
    const body = h('div', 'body', [content]);
    const toolbar = !xray && state.tab === 'Profiler' ? [profilerToolbar(c)] : [];
    panel.replaceChildren(head, tabs, ...toolbar, body, h('div', 'foot', footFor(xray ? 'X-ray' : state.tab)));
    body.scrollTop = scroll;
  }

  // the panel redraws only when something was recorded since, and not while a person is typing in it
  setInterval(() => {
    if (xray) paintUpdates(shadow);
    const typing = shadow.activeElement instanceof HTMLInputElement;
    if (state.open && record.version !== painted && !typing && !drag) paint();
  }, REFRESH_MS);
  window.addEventListener('keydown', (event) => { if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') { event.preventDefault(); setOpen(!state.open); } });
  setInterval(() => loadIssues(paint), 1000);   // the Issues count is there from the start, once the page is known
  setOpen(state.open);
}

const FEET: { [tab: string]: string } = {
  Inspect: 'Pick anything in the app to see where it is written · Ctrl+Shift+D',
  Timeline: 'Each thing done, and what it changed',
  Data: 'Every request the page made, as it made it',
  Profiler: 'Every time here is measured by the runtime in dev; none is guessed',
  Texts: 'Every language in src/lang, against the default',
  Issues: 'The same findings as muten check, for this page',
  'X-ray': 'Turn it off to go back to the tabs',
};
const footFor = (tab: string): string => FEET[tab] || '';
