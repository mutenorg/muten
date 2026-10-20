// controls: Button (an action, never a form submit) and Link (client-side navigation through the router, born active
// on its own path, and truly disabled when `disabled when …` holds).
import { Nt } from '#engine/shared/vocab.js';
import type { Emitter, FlatNode, NodeEmitter } from '#engine/shared/types.js';

function button(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'button', em.classFor('button', p));
  em.push(`el_${id}.type = 'button';`);   // an action, never a submit: inside a <form> a bare <button> also submits it
  if (n.children && n.children.length) em.genChildren(id, `el_${id}`);          // children -> clickable card
  else if (p.label !== undefined) em.interpAttr(id, 'textContent', p.label); // else static or interpolated label
  if (p.action) {
    const arg = p.arg !== undefined ? [p.arg, ...(p.argRest || [])].map((e) => em.logic.compileExpr(e, em.scope)).join(', ') : '';
    em.push(`el_${id}.addEventListener('click', () => ${em.logic.actionRef(p.action)}(${arg}));`);
  }
  em.genDynamics(id, p);
  em.appendEl(id, parentVar);
}

// client-side navigation -> <a href="/route"> intercepted by the history router
function link(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'a', em.classFor('link', p));
  em.interpAttr(id, 'href', p.to ?? '/');  // static path or interpolated (/product/{p.id})
  // Born active: the router marks links when it navigates, so a link created LATER (a menu that opens, a `when`
  // that turns on) would miss the mark until the next navigation. Mark it the moment it is made.
  em.push(`if (typeof location !== 'undefined' && el_${id}.getAttribute('href') === location.pathname) { el_${id}.classList.add('is-active'); el_${id}.setAttribute('aria-current', 'page'); }`);
  if (n.children && n.children.length) em.genChildren(id, `el_${id}`);          // children -> clickable card that navigates
  else if (p.label !== undefined) em.interpAttr(id, 'textContent', p.label);
  em.genDynamics(id, p);
  // `disabled when <cond>` on a Link: an <a> has no `disabled`, so give it the real meaning — out of the Tab
  // order, announced as disabled, and a click (or Enter) that goes nowhere. Checked at click time, so it
  // follows the condition live without re-binding.
  if (p.disabled !== undefined) {
    const off = em.logic.compileExpr(p.disabled, em.scope);
    em.push(`effect(() => { const __off = !!(${off}); el_${id}.tabIndex = __off ? -1 : 0; if (__off) el_${id}.setAttribute('aria-disabled', 'true'); else el_${id}.removeAttribute('aria-disabled'); });`);
    em.push(`el_${id}.addEventListener('click', (e) => { if (el_${id}.getAttribute('aria-disabled') === 'true') { e.preventDefault(); e.stopImmediatePropagation(); } }, true);`);
  }
  em.appendEl(id, parentVar);
}

/** How each node type here becomes DOM code. */
export const CONTROLS_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.Button, button], [Nt.Link, link]]);
