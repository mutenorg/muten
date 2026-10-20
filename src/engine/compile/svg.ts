// svg: the code of the vector layer (Svg, Group, Rect, Line, Circle, Path, Arc) and of Chart, the native dataviz on
// top of it. Geometry is expressions (reactive when they read state); a Chart redraws its marks when its rows change.
import { Nt, Ek } from '#engine/shared/vocab.js';
import type { Emitter, FlatNode, NodeEmitter } from '#engine/shared/types.js';

// native dataviz -> a <figure> wrapping a <svg> (+ optional title/legend), redrawn by __chart. No JS, no VDOM.
function chart(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  const dataSig = em.logic.bindSig(p.data);
  const dataExpr = em.queryStates.has(dataSig) ? `${dataSig}.get().data` : `${dataSig}.get()`;
  em.declEl(id, 'figure', em.classFor('chart-wrap', p)); // the wrapper carries class() + sizing; mu-chart-wrap base
  em.push(`el_${id}.style.display = 'flex'; el_${id}.style.flexDirection = 'column';`); // the svg grows, an optional legend sits below (so a fixed height() splits between them, not clips)
  if (p.label !== undefined) em.textEl(id + 't', 'figcaption', 'mu-chart-title', p.label, `el_${id}`); // optional title (static or interpolated)
  em.push(`const svg_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'svg');`);
  em.push(`svg_${id}.setAttribute('viewBox', '0 0 320 200'); svg_${id}.setAttribute('class', 'mu-chart'); svg_${id}.setAttribute('role', 'img'); svg_${id}.style.cssText = 'display:block;width:100%;flex:1 1 auto;min-height:11rem'; el_${id}.appendChild(svg_${id});`);
  let legendArg = 'null';
  if (p.color || p.kind === 'pie' || p.kind === 'donut') { em.push(`const leg_${id} = document.createElement('ul'); leg_${id}.className = 'mu-chart-legend'; el_${id}.appendChild(leg_${id});`); legendArg = `leg_${id}`; } // color(field) or a pie/donut -> a reactive legend
  em.appendEl(id, parentVar);
  const xf = p.x && p.x.kind === Ek.Ref ? p.x.name : '', yf = p.y && p.y.kind === Ek.Ref ? p.y.name : ''; // Chart reads x/y as FIELD refs
  const enc = `{ x: ${JSON.stringify(xf)}, y: ${JSON.stringify(yf)}, kind: ${JSON.stringify(p.kind || 'bar')}, color: ${JSON.stringify(p.color || '')} }`;
  em.push(`effect(() => { __chart(svg_${id}, ${dataExpr}, ${enc}, ${legendArg}); });`); // reactive: redraws marks + legend when the data changes
  // Redraw at the REAL pixel size after layout + on resize, so the SVG renders 1:1 (crisp axis text, no
  // clipping) instead of scaling a fixed viewBox. Two guards, because a naive observer here is the classic
  // "ResizeObserver loop completed with undelivered notifications":
  //   · redrawing writes viewBox and rebuilds the marks (and the legend, a SIBLING that can change the
  //     card's height and hand the flexed SVG a new one) — so a redraw can resize what is being observed.
  //     Bail out when the measured box has not actually changed, which is most deliveries.
  //   · run the redraw in the NEXT frame, never inside the observer's own delivery cycle, so a size change
  //     it does cause is delivered normally instead of overflowing the current one.
  em.push(`if (typeof ResizeObserver !== 'undefined') { let rw_${id} = -1, rh_${id} = -1, rf_${id} = 0; const ro_${id} = new ResizeObserver(() => { const w = svg_${id}.clientWidth, h = svg_${id}.clientHeight; if (w === rw_${id} && h === rh_${id}) return; rw_${id} = w; rh_${id} = h; if (rf_${id}) return; rf_${id} = requestAnimationFrame(() => { rf_${id} = 0; __chart(svg_${id}, ${dataExpr}, ${enc}, ${legendArg}); }); }); ro_${id}.observe(svg_${id}); onCleanup(() => { if (rf_${id}) cancelAnimationFrame(rf_${id}); ro_${id}.disconnect(); }); }`);
  em.genDynamics(id, p);
}

function svg(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'svg');`);
  if (p.viewBox) em.push(`el_${id}.setAttribute('viewBox', ${JSON.stringify(p.viewBox)});`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('svg', p))});`);
  em.appendEl(id, parentVar); em.genDynamics(id, p); em.genChildren(id, `el_${id}`);
}

function group(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'g');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('group', p))});`);
  em.svgStr(id, 'transform', p.transform);
  em.appendEl(id, parentVar); em.genDynamics(id, p); em.genChildren(id, `el_${id}`);
}

function rect(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'rect');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('rect', p))});`);
  em.geo(id, 'x', p.x); em.geo(id, 'y', p.y); em.geo(id, 'width', p.w); em.geo(id, 'height', p.h); em.geo(id, 'rx', p.rx);
  em.svgStr(id, 'transform', p.transform);
  em.appendEl(id, parentVar); em.genDynamics(id, p);
}

function line(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'line');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('line', p))});`);
  em.geo(id, 'x1', p.x1); em.geo(id, 'y1', p.y1); em.geo(id, 'x2', p.x2); em.geo(id, 'y2', p.y2);
  em.appendEl(id, parentVar); em.genDynamics(id, p);
}

function circle(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'circle');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('circle', p))});`);
  em.geo(id, 'cx', p.cx); em.geo(id, 'cy', p.cy); em.geo(id, 'r', p.r);
  em.appendEl(id, parentVar); em.genDynamics(id, p);
}

function path(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'path');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('path', p))});`);
  em.svgStr(id, 'd', p.d); em.svgStr(id, 'transform', p.transform);
  em.appendEl(id, parentVar); em.genDynamics(id, p);
}

// a <path> whose d is computed by __arc(cx,cy,r,from,to,inner) — pie slice / donut segment / gauge
function arc(em: Emitter, id: string, n: FlatNode, parentVar: string): void {
  const p = n.props || {};
  em.push(`const el_${id} = document.createElementNS('http://www.w3.org/2000/svg', 'path');`);
  em.push(`el_${id}.setAttribute('class', ${JSON.stringify(em.classFor('arc', p))});`);
  const arcParts = [p.cx, p.cy, p.r, p.start, p.end, p.inner];
  const arcArgs = arcParts.map((e) => (e ? em.logic.compileExpr(e, em.scope) : '0')).join(', ');
  const arcReactive = arcParts.some((e) => e !== undefined && e.kind !== Ek.Lit);
  em.push(arcReactive ? `effect(() => el_${id}.setAttribute('d', __arc(${arcArgs})));` : `el_${id}.setAttribute('d', __arc(${arcArgs}));`);
  em.appendEl(id, parentVar); em.genDynamics(id, p);
}

/** How each node type here becomes DOM code. */
export const SVG_NODES: ReadonlyMap<string, NodeEmitter> = new Map<string, NodeEmitter>([[Nt.Chart, chart], [Nt.Svg, svg], [Nt.Group, group], [Nt.Rect, rect], [Nt.Line, line], [Nt.Circle, circle], [Nt.Path, path], [Nt.Arc, arc]]);
