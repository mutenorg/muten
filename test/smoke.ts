// Browserless smoke test: compile a page IN-MEMORY, mount a fake DOM, eval the <script>,
// and verify fine-grained reactivity + where-filter + honest mutation (push, no hidden defaults).
// Self-contained (no playground page, no dist) so it survives host-app churn.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compile } from '#engine/compile/compile.js';

const SRC = `
screen users
entity User { name text  email email  role admin | member }
state {
  users  = query listUsers : list<User>
  draft  = {}              : User
  search = ""              : text
}
mock {
  listUsers: [
    { name: "Ana Torres",     email: "ana@x.io",   role: admin  },
    { name: "Bruno Diaz",     email: "bruno@x.io", role: member },
    { name: "Carla Mendez",   email: "carla@x.io", role: admin  },
    { name: "Diego Ramirez",  email: "diego@x.io", role: admin  },
    { name: "Elena Ruiz",     email: "elena@x.io", role: member },
    { name: "Federico Sosa",  email: "fede@x.io",  role: admin  },
    { name: "Gabriela Nunez", email: "gabi@x.io",  role: admin  },
    { name: "Hugo Perez",     email: "hugo@x.io",  role: member }
  ]
}
action deleteUser(uid: text) mutates users { users.remove where id == uid }
action createUser(u: User) mutates users, draft { users.push(u)  draft.reset() }
Page {
  SearchField bind(search) "Search by name"
  DataTable @users where(role == admin, name contains @search) columns(name, email, role) {
    RowAction "Delete" -> deleteUser(row.id)
  }
  Form bind(draft) submit(createUser) "Create user"
}
`;

const ir = parse(SRC);
const doc = toDoc(ir);
const { ok, diagnostics } = validate(doc);
if (!ok) { console.error('✖ validate failed:', diagnostics); process.exit(1); }
const html = compile(doc, ir.mock || {});
const code = html.split('<script type="module">')[1].split('</script>')[0];

// ── minimal DOM: models parent/sibling links so KEYED reconciliation (insertBefore + .remove()) works ──
const registry = [];
const detach = (node) => { const p = node.parentNode; if (p) { const i = p.children.indexOf(node); if (i >= 0) p.children.splice(i, 1); node.parentNode = null; } };
const nextSiblingOf = (node) => { const p = node.parentNode; if (!p) return null; const i = p.children.indexOf(node); return i >= 0 && i + 1 < p.children.length ? p.children[i + 1] : null; };
function makeEl(tag) {
  const el = {
    tag, children: [], handlers: {}, className: '', value: '', textContent: '', type: '', placeholder: '', parentNode: null,
    get nextSibling() { return nextSiblingOf(this); },
    appendChild(c) { detach(c); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(node, ref) { detach(node); node.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node); return node; },
    removeChild(c) { detach(c); return c; },
    remove() { detach(this); },
    replaceChildren(...nodes) { for (const c of this.children.slice()) detach(c); for (const n of nodes) this.appendChild(n); },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    createTHead() { const h = makeEl('thead'); this.appendChild(h); return h; },
    createTBody() { const b = makeEl('tbody'); this.appendChild(b); return b; },
    insertRow() { const r = makeEl('tr'); this.appendChild(r); return r; },
  };
  registry.push(el);
  return el;
}
const makeComment = (text) => ({ tag: '#comment', text, parentNode: null, get nextSibling() { return nextSiblingOf(this); }, remove() { detach(this); } });
const app = makeEl('div');
const document = { getElementById: () => app, createElement: (t) => makeEl(t), createComment: (t) => makeComment(t) };

// ── evaluate the generated module with the fake DOM injected ──
new Function('document', code)(document);

// queries are async (mock latency) → wait for the data to load before asserting
await new Promise((r) => setTimeout(r, 600));

// ── assertions ──
let failures = 0;
const tbody = registry.find((el) => el.tag === 'tbody');
const search = registry.find((el) => el.className === 'search');
const form = registry.find((el) => el.handlers.submit);
const rows = () => tbody.children.filter((c) => c.tag === 'tr').length; // keyed rows are <tr> nodes between the anchor comments
const tick = () => new Promise((r) => setTimeout(r, 0)); // render effects are BATCHED (microtask) → let them flush before asserting
const assert = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '✓' : 'x'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`);
  if (!ok) failures++;
};

assert('admins visible at start', rows(), 5);              // static where role==admin
search.handlers.input({ target: { value: 'car' } });
await tick();
assert('filters by "car"', rows(), 1);                    // dynamic where name contains
search.handlers.input({ target: { value: 'zz' } });
await tick();
assert('filters by "zz"', rows(), 0);
search.handlers.input({ target: { value: '' } });
await tick();
assert('back to 5 when cleared', rows(), 5);              // reactivity on search

const nameField = registry.find((el) => el.placeholder === 'name');
const roleField = registry.find((el) => el.tag === 'select');
nameField.handlers.input({ target: { value: 'Zoe Admin' } });
roleField.handlers.input({ target: { value: 'admin' } });
form.handlers.submit({ preventDefault() {} });
await tick();
assert('create an admin → table goes to 6', rows(), 6);

nameField.handlers.input({ target: { value: 'Otto Member' } });
roleField.handlers.input({ target: { value: 'member' } });
form.handlers.submit({ preventDefault() {} });
await tick();
assert('create a member → still 6 (filtered by where)', rows(), 6);

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
