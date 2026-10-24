// dynamics: what any element may carry on top of its own code: its id (an anchor), classes that follow state
// (`class(on when x)`, `class("status-{x}")`), events (`on(event: action)`, with the natural value as the argument;
// touch gestures too: `on(swipe-left: next)`, `on(pinch: zoom)`),
// a drag source or drop zone, aria/data attributes, `disabled when …`, and `style(name: …)` CSS variables. Every one
// that reads state is an effect, so it follows it live.
import { Ek, DATA_PREFIX, GESTURES } from '#engine/shared/vocab.js';
import type { Emitter, NodeProps } from '#engine/shared/types.js';

// the value an event hands its action: an input its value, a key its key, a scroll how many pixels are left below
// (so a list asks for its next page as it nears the end: `on(scroll: more)` + `if left < 200 { … }`)
const EVENT_ARG: { readonly [event: string]: string } = { input: 'e.target.value', change: 'e.target.value', keydown: 'e.key', keyup: 'e.key', keypress: 'e.key', scroll: 'Math.round(e.target.scrollHeight - e.target.scrollTop - e.target.clientHeight)' };

/** The lines that give an element its reactive bits. */
export function dynamicsLines(em: Emitter, id: string, p: NodeProps): void {
  if (p.id) em.push(`el_${id}.id = ${JSON.stringify(p.id)};`);   // id("features") — the anchor a `-> "#features"` scrolls to
  for (const c of p.class || []) if (typeof c !== 'string') {
    if ('interp' in c) {
      // nothing in it reads state (a part's `class("notice-{tone}")` called with tone: "info"): set once, no effect
      // re-checking a class that can never change
      const fixed = c.interp.parts.every((part) => typeof part === 'string') ? c.interp.parts.join('').trim().split(/\s+/).filter(Boolean) : null;
      if (fixed) { if (fixed.length) em.push(`el_${id}.classList.add(${fixed.map((token) => JSON.stringify(token)).join(', ')});`); continue; }
      // `class("status-{x}")` — interpolated token, applied reactively: swap the previous computed token(s)
      // for the new whenever the value changes (split() so a multi-word result is handled token-by-token).
      const js = em.interpConcat(c.interp);
      em.push(`{ let __cp = ''; effect(() => { const __c = ${js}; if (__c === __cp) return; if (__cp) el_${id}.classList.remove(...__cp.split(' ').filter(Boolean)); if (__c) el_${id}.classList.add(...__c.split(' ').filter(Boolean)); __cp = __c; }); }`);
      continue;
    }
    // `class("a b c" when cond)` may hold MULTIPLE tokens; classList.toggle rejects a token with
    // spaces, so split (at compile time) and toggle each with the condition computed once.
    const toggles = c.name.trim().split(/\s+/).map((t) => `el_${id}.classList.toggle(${JSON.stringify(t)}, __on);`).join(' ');
    em.push(`effect(() => { const __on = !!(${em.logic.compileExpr(c.cond, em.scope)}); ${toggles} });`);
  }
  // on(event: action): table-driven event PAYLOAD → the natural scalar flows to the action (value / key). An
  // action that takes no arg simply ignores it. `drop` is the drag-pack target (fires action(draggedId, group)).
  // `scroll` hands over how many pixels are left below the fold, so a list can ask for its next page as it
  // nears the end: `on(scroll: more)` + `action more(left: number) { if left < 200 { … } }`.
  for (const [event, act] of Object.entries(p.on || {})) {
    if (typeof act !== 'string') continue;
    // synthetic: Esc anywhere on the page while this node is on screen (a modal, a sheet closes with it)
    // a touch gesture (runtime-gesture.ts): one recognizer per element, whatever it listens for; a pinch hands the scale
    if (GESTURES.has(event)) { em.push(`__gesture(el_${id}, ${JSON.stringify(event)}, (v) => ${em.logic.actionRef(act)}(v));`); continue; }
    if (event === 'escape') { em.push(`{ const __esc = (e) => { if (e.key === 'Escape') ${em.logic.actionRef(act)}(); }; document.addEventListener('keydown', __esc); onCleanup(() => document.removeEventListener('keydown', __esc)); }`); continue; }
    if (event === 'enter') em.push(`el_${id}.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ${em.logic.actionRef(act)}(); } });`); // synthetic: Enter submits (no newline); Shift+Enter is a newline
    // synthetic: `typed` fires ONCE the user stops typing (300ms after the last key), with the value — a search
    // asks the server once per pause instead of once per keystroke.
    else if (event === 'typed') em.push(`{ let __pause = 0; el_${id}.addEventListener('input', (e) => { const __v = e.target.value; clearTimeout(__pause); __pause = setTimeout(() => ${em.logic.actionRef(act)}(__v), 300); }); }`);
    else if (event === 'drop') { // register a pointer-DnD drop zone (innermost-wins collision → nested-safe)
      // The group interpolates: `droptarget("{row.id}")` compiles to `String(row.id ?? '')`, so each row in a
      // list is a zone that passes its OWN id as the drop's second arg → `reorder(draggedId, targetId)`.
      let groupJs = "''"; let arg = '';
      if (p.dropGroup !== undefined) {
        groupJs = typeof p.dropGroup === 'string' ? JSON.stringify(p.dropGroup)
          : 'kind' in p.dropGroup ? em.interpConcat(p.dropGroup) : "''";
        // Second arg: where the row LANDS in a sortable (`__before`), else the zone's own group.
        // Third arg: ALWAYS the zone's group — so a nested sortable can get BOTH the landing
        // position AND which group it landed in (`move(id, before, group)`). Actions that take two
        // args ignore it, so this stays backward compatible with `reorder(id, target)`.
        arg = ', (__before !== undefined ? __before : ' + groupJs + '), ' + groupJs;
      }
      em.push(`__drop(el_${id}, ${groupJs}, (__dragId, __before) => ${em.logic.actionRef(act)}(__dragId${arg}));`);
    }
    else em.push(`el_${id}.addEventListener(${JSON.stringify(event)}, (e) => ${em.logic.actionRef(act)}(${EVENT_ARG[event] || ''}));`);
  }
  // draggable(<id>): a pointer-DnD source — a styled clone tracks the pointer; the id is read live at grab time.
  if (p.draggable !== undefined) em.push(`__drag(el_${id}, () => String(${em.logic.compileExpr(p.draggable, em.scope)}));`);
  // aria(...) / data(...) — author-expressed attributes: `key` → `aria-<key>` (`role` → `role`). A literal value is a
  // static attribute; a value that reads state is wrapped in an effect, so e.g. `aria(expanded: open)` stays in sync.
  // An EMPTY value means «no attribute»: a part's optional `label: text = ""` must not stamp aria-label="" (that
  // erases the element's accessible name), so an empty literal is skipped and an empty live value removes it.
  for (const [key, expr] of Object.entries(p.aria || {})) {
    const attr = JSON.stringify(key === 'role' || key.startsWith(DATA_PREFIX) ? key : 'aria-' + key);   // data(...) keys arrive already named `data-*`
    const val = em.logic.compileExpr(expr, em.scope);
    if (expr.kind === Ek.Lit) { if (expr.value !== '') em.push(`el_${id}.setAttribute(${attr}, String(${val}));`); }
    else em.push(`effect(() => { const __av = String(${val}); if (__av === '') el_${id}.removeAttribute(${attr}); else el_${id}.setAttribute(${attr}, __av); });`);
  }
  // disabled: `disabled when <cond>` → `el.disabled`. A literal (bare `disabled`) sets it once; a cond that
  // reads state is wrapped in an effect so the control enables/disables live (the "disable until valid" gate).
  if (p.disabled !== undefined) {
    const js = em.logic.compileExpr(p.disabled, em.scope);
    if (p.disabled.kind === Ek.Lit) em.push(`el_${id}.disabled = ${js};`);
    else em.push(`effect(() => { el_${id}.disabled = !!(${js}); });`);
  }
  // style(name: "..") → CSS custom property `--name`, reactive when the value interpolates state. Bounded to
  // CSS variables only (muten prepends `--`), so it never competes with class()/Tailwind; CSS reads var(--name).
  for (const [name, sv] of Object.entries(p.styleVars || {})) {
    const prop = JSON.stringify('--' + name.replace(/^-+/, ''));
    if (typeof sv === 'string') { em.push(`el_${id}.style.setProperty(${prop}, ${JSON.stringify(sv)});`); continue; }
    const js = em.interpConcat(sv);
    em.push(`effect(() => el_${id}.style.setProperty(${prop}, ${js}));`);
  }
}
