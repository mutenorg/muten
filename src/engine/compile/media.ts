// media: Image (lazy by default, eager on request, its src made safe when it comes from data), Icon (inline SVG
// resolved at build; from data, only the names the page spells out) and Video (bare-keyword flags).
import { Nt } from '#engine/shared/vocab.js';
import { iconNames } from '#engine/ir/icon-names.js';
import type { Emitter, FlatNode, NodeEmitter } from '#engine/shared/types.js';

function image(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.declEl(id, 'img', em.classFor('image', p));
  if (p.id) em.push(`el_${id}.id = ${JSON.stringify(p.id)};`); // Image is the one case that skips genDynamics
  em.interpAttr(id, 'src', p.src);
  em.interpAttr(id, 'alt', p.alt ?? ''); // alt required by the manifest; "" = decorative
  // lazy unless `eager`: a page of 600 photos asks for the few near the screen; decoding never blocks a frame
  em.push(p.eager ? `el_${id}.loading = 'eager'; el_${id}.fetchPriority = 'high'; el_${id}.decoding = 'async';` : `el_${id}.loading = 'lazy'; el_${id}.decoding = 'async';`);
  em.appendEl(id, parentVar);
}

// `Icon "set:name"` -> inline SVG resolved at build (Iconify); static name, no JS shipped
function icon(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const svgOf = (ref: string): string => (em.opts.iconResolver ? em.opts.iconResolver(ref) : '');
  em.declEl(id, 'span', em.classFor('icon', p));
  em.push(`el_${id}.setAttribute('aria-hidden', 'true');`); // a11y: icons are decorative by default; meaning lives in adjacent text
  if (p.name && typeof p.name === 'object' && 'kind' in p.name) {   // `Icon "{tab.icon}"`: the names it can take ship, the one it is shows
    const svgs = Object.fromEntries((iconNames(p.name, em.doc) || []).map((ref) => [ref, svgOf(ref)]));
    em.push(`{ const __svgs = ${JSON.stringify(svgs)}; ${em.writeOnChange(`el_${id}`, 'innerHTML', `__svgs[${em.interpConcat(p.name)}] ?? ''`)} }`);
  } else em.push(`el_${id}.innerHTML = ${JSON.stringify(svgOf(typeof p.name === 'string' ? p.name : ''))};`);
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
}

function video(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const tag = n.type === Nt.Audio ? 'audio' : 'video';   // Audio is the same element family, the browser's own player
  em.declEl(id, tag, em.classFor(tag, p));
  em.interpAttr(id, 'src', p.src);
  for (const f of p.flags || []) em.push(`el_${id}.${f === 'playsinline' ? 'playsInline' : f} = true;`);
  em.appendEl(id, parentVar);
  em.genDynamics(id, p);
}

/** How each node type here becomes DOM code. */
// a drawing surface for a package (Chart.js, a WebGL shader): its id is how the package finds it
function canvas(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  em.declEl(id, 'canvas', em.classFor('canvas', n.props || {}));
  em.appendEl(id, parentVar);
  em.genDynamics(id, n.props || {});
}

export const MEDIA_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.Image, image], [Nt.Icon, icon], [Nt.Video, video], [Nt.Audio, video], [Nt.Canvas, canvas]]);
