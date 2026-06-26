import type { Value } from '#engine/shared/types.js';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

// ssr: minimal fake DOM for build-time pre-rendering (SSR/SSG).
// Executes the real compiled module against it and serializes the result, so there is nothing
// to keep in sync with the browser path. Implements exactly the ops genNode emits: any op it
// lacks throws, and the build falls back to the CSR shell for that page. Consumed by build.ts.

const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source']);

const escText = (s: string): string => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); // coerce: a DataTable number/bool cell sets textContent to a non-string
const escAttr = (s: string): string => escText(s).replace(/"/g, '&quot;');

class SNode {
  parentNode: SElement | null = null;
  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.children.indexOf(this);
    if (i >= 0) parent.children.splice(i, 1);
    this.parentNode = null;
  }
}

class SText extends SNode { constructor(public text: string) { super(); } }
class SComment extends SNode { constructor(public text: string) { super(); } } // when/each anchors, stripped from output

class SElement extends SNode {
  children: SNode[] = [];
  attrs: { [k: string]: string } = {};
  className = '';
  // element properties the generated code assigns directly; serialized as attributes
  src = ''; alt = ''; href = ''; type = ''; value = ''; placeholder = '';
  style = { setProperty(_name: string, _val: string): void { /* SSR is structure-only; a `style(--v)` CSS var doesn't change serialized HTML */ } };
  // reactive classes (toggle / `class("status-{x}")`) run their effect once at SSR, reflecting the initial state into className
  get classList() {
    const set = (): Set<string> => new Set(this.className.split(' ').filter(Boolean));
    const commit = (s: Set<string>): void => { this.className = [...s].join(' '); };
    return {
      add: (...ts: string[]): void => { const s = set(); for (const t of ts) s.add(t); commit(s); },
      remove: (...ts: string[]): void => { const s = set(); for (const t of ts) s.delete(t); commit(s); },
      toggle: (t: string, on?: boolean): void => { const s = set(); const want = on === undefined ? !s.has(t) : on; if (want) s.add(t); else s.delete(t); commit(s); },
    };
  }
  private text = '';
  constructor(public tag: string) { super(); }

  get childNodes(): SNode[] { return this.children; }
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = v; for (const c of this.children) c.parentNode = null; this.children = []; }

  appendChild<T extends SNode>(child: T): T {
    if (child instanceof SFragment) { for (const c of [...child.children]) this.appendChild(c); return child; }
    child.remove(); child.parentNode = this; this.children.push(child); this.text = '';
    return child;
  }
  insertBefore(node: SNode, ref: SNode | null): SNode {
    const nodes = node instanceof SFragment ? [...node.children] : [node];
    for (const n of nodes) n.remove();
    const at = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(at >= 0 ? at : this.children.length, 0, ...nodes);
    for (const n of nodes) n.parentNode = this;
    if (node instanceof SFragment) node.children = [];
    return node;
  }
  replaceChildren(...nodes: SNode[]): void {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    for (const n of nodes) this.appendChild(n);
  }
  setAttribute(name: string, val: string): void { this.attrs[name] = val; }
  addEventListener(): void { /* SSR has no events */ }
  // table builders (DataTable)
  createTHead(): SElement { const t = new SElement('thead'); this.appendChild(t); return t; }
  createTBody(): SElement { const t = new SElement('tbody'); this.appendChild(t); return t; }
  insertRow(): SElement { const r = new SElement('tr'); this.appendChild(r); return r; }
}

class SFragment extends SElement { constructor() { super('#fragment'); } }

class SDocument {
  createElement(tag: string): SElement { return new SElement(tag); }
  createComment(text: string): SComment { return new SComment(text); }
  createDocumentFragment(): SFragment { return new SFragment(); }
  createTextNode(text: string): SText { return new SText(text); }
}

function serialize(node: SNode): string {
  if (node instanceof SText) return escText(node.text);
  if (node instanceof SComment) return '';
  if (!(node instanceof SElement)) return '';
  if (node.tag === '#fragment') return node.children.map(serialize).join('');
  const attrs: string[] = [];
  if (node.className) attrs.push(`class="${escAttr(node.className)}"`);
  const prop = (name: string, v: string): void => { if (v) attrs.push(`${name}="${escAttr(v)}"`); };
  prop('src', node.src); prop('alt', node.alt); prop('href', node.href);
  prop('type', node.type); prop('value', node.value); prop('placeholder', node.placeholder);
  for (const [k, v] of Object.entries(node.attrs)) attrs.push(`${k}="${escAttr(v)}"`);
  const open = `<${node.tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`;
  if (VOID.has(node.tag)) return open;
  const inner = node.children.length ? node.children.map(serialize).join('') : escText(node.textContent);
  return `${open}${inner}</${node.tag}>`;
}

// Execute a Fmt.Ssr factory (self-contained: inlined runtime + synchronous mock data) against the fake
// DOM and return the rendered inner HTML of #app. Throws if the page touches something the fake DOM or
// Node lacks (stores, exotic custom JS): the caller falls back to the CSR shell.
export function renderSsrBody(factoryCode: string): string {
  const document = new SDocument();
  const app = new SElement('div');
  // ponytail: executing OUR OWN compiled output in a fake DOM — not user input. No sandbox needed.
  const run = new Function('document', 'app', '__params', factoryCode);
  run(document, app, {});
  return app.children.map(serialize).join('');
}

// Fetch a page's remote `sources` at build so source-backed lists pre-render (SSG).
// Mirrors the browser data layer (bare URL -> JSON array; { url, at } -> json[at]).
// A failed/offline fetch leaves the list empty so the client fetches at runtime.
export async function fetchSources(sources: { [name: string]: Value }, api: Value = {}): Promise<{ [name: string]: Value }> {
  const out: { [name: string]: Value } = {};
  for (const [name, src] of Object.entries(sources)) {
    const r = sourceRequest(src, api);
    if (!r.url) continue;
    if (r.method !== 'GET') { console.log(`  • source "${name}" is ${r.method} — not fetched at build (runs client-side)`); continue; }
    try {
      const json: Value = await (await fetch(r.url, { headers: r.headers })).json();
      const rows = sourceRows(json, r.at);
      out[name] = rows;
      console.log(`  • fetched source "${name}" (${rows.length} rows) ← ${r.url}`);
    } catch { /* offline / bad source → the client fetches it at runtime */ }
  }
  return out;
}
