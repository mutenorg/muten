// static: the zero-JS half of the compiler. Which nodes have nothing reactive in them (a node, a whole subtree), and the
// HTML such a subtree renders to: a fully static page ships as this HTML alone, and every static subtree of a reactive
// page is cloned from it (__clone) instead of built node by node. Mirrors genNode's tags, classes and a11y exactly
// (test/static-parity.ts holds the two paths together).
import { Nt, Ek } from '#engine/shared/vocab.js';
import { CONTAINERS } from '#engine/compile/helpers.js';
import type { NodeProps, StaticFacts, StringPropValue } from '#engine/shared/types.js';

const escHtml = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => escHtml(s).replace(/"/g, '&quot;');
const strOf = (v: StringPropValue | undefined): string => (typeof v === 'string' ? v : ''); // static pages carry only plain strings

// what makes a node reactive: its type, a prop that wires behaviour, or an interpolated text
const REACTIVE_TYPES: ReadonlySet<string> = new Set([Nt.When, Nt.Each, Nt.Custom, Nt.Form, Nt.SearchField, Nt.Number, Nt.Range, Nt.Date, Nt.File, Nt.DataTable, Nt.Slot, Nt.Chart, Nt.Svg, Nt.Group, Nt.Rect, Nt.Line, Nt.Circle, Nt.Path, Nt.Arc]);
const REACTIVE_PROPS: ReadonlyArray<keyof NodeProps> = ['action', 'bind', 'submit', 'on', 'inputs', 'data'];
const INTERP_PROPS: ReadonlyArray<keyof NodeProps> = ['value', 'src', 'alt', 'label', 'to', 'summary', 'name'];

/** The static analysis and renderer for one page's nodes. */
export function staticRenderer(facts: StaticFacts): { nodeIsStatic: (id: string) => boolean; subtreeIsStatic: (id: string) => boolean; renderStatic: (id: string) => string } {
  const { nodes, classFor, iconSvg, headCells } = facts;

  // Is this ONE node static: no state, no listener, nothing genDynamics writes at runtime? (Its children aside.)
  function nodeIsStatic(id: string): boolean {
    const n = nodes[id]; const p = n.props || {};
    if (REACTIVE_TYPES.has(n.type)) return false;
    if (REACTIVE_PROPS.some((k) => p[k] !== undefined)) return false;
    if ((p.class || []).some((c) => typeof c !== 'string')) return false; // reactive class toggle -> not static
    if ((p.aria && Object.keys(p.aria).length) || (p.styleVars && Object.keys(p.styleVars).length) || p.disabled !== undefined || p.draggable !== undefined) return false; // aria()/style()/disabled/draggable write attrs+listeners at runtime via genDynamics -> the static HTML path would silently drop them
    return !INTERP_PROPS.some((k) => { const v = p[k]; return !!v && typeof v === 'object' && 'kind' in v && v.kind === Ek.Interp; });
  }
  const staticSubtrees = new Map<string, boolean>();
  function subtreeIsStatic(id: string): boolean {
    let known = staticSubtrees.get(id);
    if (known === undefined) { known = nodeIsStatic(id) && (nodes[id].children || []).every(subtreeIsStatic); staticSubtrees.set(id, known); }
    return known;
  }

  // render a static node to an HTML string (recursively), mirroring genNode's tags/classes, no JS.
  function renderStatic(id: string): string {
    const n = nodes[id]; const p = n.props || {};
    const kids = (): string => (nodes[id].children || []).map(renderStatic).join('');
    // class + the literal id(): every static tag below routes through this, so an anchor target survives the
    // zero-JS path too — a page whose only "dynamic" bit is id() stays static.
    const cls = (base: string): string => ` class="${escAttr(classFor(base, p))}"${p.id ? ` id="${escAttr(p.id)}"` : ''}`;
    const cont = CONTAINERS[n.type];
    if (cont) {   // the same a11y genNode emits: a labelled <nav>, and <main> as the skip-link / navigation focus target
      const [tag, base] = cont;
      const label = n.type === Nt.Nav && typeof p.label === 'string' ? ` aria-label="${escAttr(p.label)}"` : '';
      const main = n.type === Nt.Page && !p.id ? ' id="mu-main" tabindex="-1"' : '';
      return `<${tag}${cls(base)}${label}${main}>${kids()}</${tag}>`;
    }
    switch (n.type) {
      case Nt.Text: return `<p${cls('text')}>${escHtml(strOf(p.value))}</p>`;
      case Nt.Span: return `<span${cls('span')}>${escHtml(strOf(p.value))}</span>`;
      case Nt.Title: { const lvl = p.level || 'h1'; return `<${lvl}${cls('title')}>${escHtml(strOf(p.value))}</${lvl}>`; }
      case Nt.Image: return `<img${cls('image')} src="${escAttr(strOf(p.src))}" alt="${escAttr(strOf(p.alt))}"${p.eager ? ' loading="eager" fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
      case Nt.Icon: return `<span${cls('icon')} aria-hidden="true">${iconSvg(strOf(p.name))}</span>`; // decorative, as genNode marks it
      case Nt.Audio: return `<audio${cls('audio')} src="${escAttr(strOf(p.src))}"${(p.flags || []).map((f) => ` ${f}`).join('')}></audio>`;
      case Nt.Canvas: return `<canvas${cls('canvas')}></canvas>`;
      case Nt.Video: return `<video${cls('video')} src="${escAttr(strOf(p.src))}"${(p.flags || []).map((f) => ` ${f}`).join('')}></video>`;
      case Nt.Link: return `<a${cls('link')} href="${escAttr(strOf(p.to) || '/')}">${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</a>`;
      case Nt.Button: return `<button type="button"${cls('button')}>${(n.children && n.children.length) ? kids() : escHtml(strOf(p.label))}</button>`;
      case Nt.List: { const tag = p.ordered ? 'ol' : 'ul'; return `<${tag}${cls('list')}>${(nodes[id].children || []).map((cid) => `<li>${renderStatic(cid)}</li>`).join('')}</${tag}>`; }
      case Nt.Table: {
        const rows = nodes[id].children || [];
        const isHead = (k: string): boolean => nodes[k].type === Nt.Row && !!nodes[k].props?.head;
        const heads = rows.filter(isHead), body = rows.filter((k) => !isHead(k));
        const grp = (tag: string, rs: string[]): string => rs.length ? `<${tag}>${rs.map(renderStatic).join('')}</${tag}>` : '';
        return `<table${cls('table')}>${grp('thead', heads)}${grp('tbody', body)}</table>`;
      }
      case Nt.Row: return `<tr${cls('row')}>${kids()}</tr>`;
      case Nt.Cell: { const tag = headCells.has(id) ? 'th' : 'td'; return `<${tag}${cls('cell')}>${(n.children && n.children.length) ? kids() : escHtml(strOf(p.value))}</${tag}>`; }
      case Nt.Details: return `<details${cls('details')}${p.group ? ` name="${escAttr(p.group)}"` : ''}${p.open ? ' open' : ''}><summary class="mu-summary">${escHtml(strOf(p.summary))}</summary>${kids()}</details>`;
      default: return '';
    }
  }


  return { nodeIsStatic, subtreeIsStatic, renderStatic };
}
