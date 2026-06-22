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
action deleteUser mutates users <- id { users.remove(u => u.id == id) }
action createUser mutates users, draft <- draft { users.push(draft)  draft.reset() }
Page {
  SearchField bind @search "Search by name"
  DataTable @users where(role == admin, name contains @search) columns(name, email, role) {
    RowAction "Delete" -> deleteUser(row.id)
  }
  Form bind @draft submit createUser "Create user"
}
`;

const ir = parse(SRC);
const doc = toDoc(ir);
const { ok, diagnostics } = validate(doc);
if (!ok) { console.error('✖ validate failed:', diagnostics); process.exit(1); }
const html = compile(doc, ir.mock || {});
const code = html.split('<script type="module">')[1].split('</script>')[0];

// ── minimal DOM ──
const registry = [];
function makeEl(tag) {
  const el = {
    tag, children: [], handlers: {}, className: '', value: '', textContent: '', type: '', placeholder: '',
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    replaceChildren(...nodes) { this.children = nodes; this.__rows = nodes.length; },
    createTHead() { const h = makeEl('thead'); this.children.push(h); return h; },
    createTBody() { const b = makeEl('tbody'); this.children.push(b); return b; },
    insertRow() { const r = makeEl('tr'); this.children.push(r); return r; },
  };
  registry.push(el);
  return el;
}
const app = makeEl('div');
const document = { getElementById: () => app, createElement: (t) => makeEl(t) };

// ── evaluate the generated module with the fake DOM injected ──
new Function('document', code)(document);

// queries are async (mock latency) → wait for the data to load before asserting
await new Promise((r) => setTimeout(r, 600));

// ── assertions ──
let failures = 0;
const tbody = registry.find((el) => el.tag === 'tbody'); // not just any el with __rows — app gets it from clear-on-boot
const search = registry.find((el) => el.className === 'search');
const form = registry.find((el) => el.handlers.submit);
const assert = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '✓' : 'x'} ${label}: ${got}${ok ? '' : ` (expected ${want})`}`);
  if (!ok) failures++;
};

assert('admins visible at start', tbody.__rows, 5);              // static where role==admin
search.handlers.input({ target: { value: 'car' } });
assert('filters by "car"', tbody.__rows, 1);                    // dynamic where name contains
search.handlers.input({ target: { value: 'zz' } });
assert('filters by "zz"', tbody.__rows, 0);
search.handlers.input({ target: { value: '' } });
assert('back to 5 when cleared', tbody.__rows, 5);              // reactivity on @search

const nameField = registry.find((el) => el.placeholder === 'name');
const roleField = registry.find((el) => el.tag === 'select');
nameField.handlers.input({ target: { value: 'Zoe Admin' } });
roleField.handlers.input({ target: { value: 'admin' } });
form.handlers.submit({ preventDefault() {} });
assert('create an admin → table goes to 6', tbody.__rows, 6);

nameField.handlers.input({ target: { value: 'Otto Member' } });
roleField.handlers.input({ target: { value: 'member' } });
form.handlers.submit({ preventDefault() {} });
assert('create a member → still 6 (filtered by where)', tbody.__rows, 6);

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
