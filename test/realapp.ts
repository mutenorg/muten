// Real-app RUNTIME test: compile a page that uses the lambda-free list ops (`count where`, `sum by`,
// `max by`, `each … where`, `patch where … with`, `remove where`), mount it in a fake DOM, fire the
// actions, and assert the derived values + keyed columns update reactively. Browserless, self-contained.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compile } from '#engine/compile/compile.js';

const SRC = `
screen tracker
entity Issue { title text  status open | doing | done  points number }
state {
  issues = [
    { title: "A", status: "open",  points: 5 }
    { title: "B", status: "open",  points: 8 }
    { title: "C", status: "doing", points: 2 }
    { title: "D", status: "done",  points: 1 }
  ] : list<Issue>
}
get openCount = issues.count where status == "open"
get points    = issues.sum by points
get topPoints = issues.max by points
action advance(issueId: text) mutates issues { issues.patch where id == issueId with { status: "doing" } }
action drop(issueId: text)    mutates issues { issues.remove where id == issueId }
Page {
  Text "open={openCount} pts={points} top={topPoints}" class("kpi")
  Stack class("open") {
    each issues as i where i.status == "open" {
      Stack class("row") {
        Text "{i.title}"
        Button "start" -> advance(i.id)
        Button "drop"  -> drop(i.id)
      }
    }
  }
}
`;

const doc = toDoc(parse(SRC));
const { ok, diagnostics } = validate(doc);
if (!ok) { console.error('x validate failed:', diagnostics); process.exit(1); }
const html = compile(doc, {});
const code = html.split('<script type="module">')[1].split('</script>')[0];

// ── fake DOM with parent/sibling links (keyed reconciliation needs insertBefore + .remove()) ──
const registry: any[] = [];
const detach = (n: any) => { const p = n.parentNode; if (p) { const i = p.children.indexOf(n); if (i >= 0) p.children.splice(i, 1); n.parentNode = null; } };
const nextSiblingOf = (n: any) => { const p = n.parentNode; if (!p) return null; const i = p.children.indexOf(n); return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null; };
function makeEl(tag: string): any {
  const el: any = {
    tag, children: [], handlers: {}, className: '', textContent: '', value: '', placeholder: '', type: '', parentNode: null,
    get nextSibling() { return nextSiblingOf(this); },
    get childNodes() { return this.children; }, // `each` builds rows in a fragment then reads .childNodes
    appendChild(c: any) { detach(c); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(node: any, ref: any) { detach(node); node.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node); return node; },
    removeChild(c: any) { detach(c); return c; },
    remove() { detach(this); },
    replaceChildren(...nodes: any[]) { for (const c of this.children.slice()) detach(c); for (const n of nodes) this.appendChild(n); },
    addEventListener(t: string, fn: any) { this.handlers[t] = fn; },
  };
  registry.push(el);
  return el;
}
const makeComment = (text: string): any => ({ tag: '#comment', text, parentNode: null, get nextSibling() { return nextSiblingOf(this); }, remove() { detach(this); } });
const app = makeEl('div');
const document = { getElementById: () => app, createElement: (t: string) => makeEl(t), createComment: (t: string) => makeComment(t), createDocumentFragment: () => makeEl('#fragment') };

new (Function as any)('document', code)(document);

const tick = () => new Promise((r) => setTimeout(r, 0)); // batched render effects flush in a microtask
let failures = 0;
const assert = (label: string, got: any, want: any) => { const ok = got === want; console.log(`${ok ? '✓' : 'x'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`); if (!ok) failures++; };

const hasClass = (e: any, c: string) => typeof e.className === 'string' && e.className.split(/\s+/).includes(c); // base class is prepended (e.g. "text kpi")
const isLive = (e: any) => { let n = e; while (n) { if (n === app) return true; n = n.parentNode; } return false; }; // a disposed subtree keeps internal parent links — only count nodes whose ancestry reaches the mounted app
const kpi = () => registry.find((e) => hasClass(e, 'kpi'))?.textContent;
const rows = () => registry.filter((e) => hasClass(e, 'row') && isLive(e));
const starts = () => registry.filter((e) => e.tag === 'button' && e.textContent === 'start' && isLive(e));
const drops = () => registry.filter((e) => e.tag === 'button' && e.textContent === 'drop' && isLive(e));

await tick();
assert('initial KPIs (count where / sum by / max by)', kpi(), 'open=2 pts=16 top=8');
assert('open column rows (each … where)', rows().length, 2);

// advance the first open issue → `patch where id == issueId with { status: "doing" }` moves it out of the column
starts()[0].handlers.click();
await tick();
assert('after advance: open count', rows().length, 1);
assert('after advance: KPIs recompute (open 2->1, pts unchanged)', kpi(), 'open=1 pts=16 top=8');

// drop the remaining open issue → `remove where id == issueId` deletes it
drops()[0].handlers.click();
await tick();
assert('after drop: open column empty', rows().length, 0);
assert('after drop: KPIs recompute (8-pt issue gone)', kpi(), 'open=0 pts=8 top=5');

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
