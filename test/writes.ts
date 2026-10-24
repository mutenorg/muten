// Server CRUD: create/update/delete on a source-backed list compile to __write (POST/PUT/DELETE) + a
// reactive update of the list. The HTTP request is built by sourceRequest (live-verified in test/ssr.ts);
// here we lock the generated shape — method, url (/:id), body, error handling, and the list mutation.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compileModule as compilePage, compileStore as compileStoreModule } from '#engine/compile/compile.js';
import { dataModule } from '#engine/compile/emit.js';
// the data layer lives once per app now (virtual:muten/data); these checks read a page or a store together with it
const withLayer = (code: string): string => (code.includes('__dataLayer(') ? `${code}\n${dataModule()}` : code);
const compileModule = (...args: Parameters<typeof compilePage>): string => withLayer(compilePage(...args));
const compileStore = (...args: Parameters<typeof compileStoreModule>): string => withLayer(compileStoreModule(...args));

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const js = compileModule(toDoc(parse(`screen shop
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders", at: "data" } }
action buy  mutates orders <- item { orders.create(item) }
action edit mutates orders <- item { orders.update(item) }
action drop mutates orders <- item { orders.delete(item) }
Page { each orders as o { Text "{o.title}" } }`)));

ok('create → POST through __crud', js.includes('await __crud("orders", \'POST\', item,'));
ok('update → PUT through __crud', js.includes('await __crud("orders", \'PUT\', item,'));
ok('delete → DELETE through __crud', js.includes('await __crud("orders", \'DELETE\', item,'));
ok('__crud reads and writes the query .data', js.includes('() => orders.get().data, (__d) => orders.set({ ...orders.get(), data: __d })'));
ok('__crud helper emitted', js.includes('function __crud(name, method, item, get, set)'));
ok('write failure captured to action .error', js.includes('__error_buy.set(String(__e))'));
ok('__write helper emitted', js.includes('function __write(name, method, id, body)'));
ok('__write JSON-encodes the body', js.includes('init.body = JSON.stringify(body)'));
ok('__write appends /:id', js.includes('encodeURIComponent(id)'));
ok('__write throws on !ok', js.includes("if (!r.ok) return r.json().catch(() => null).then((j) => {") && js.includes("throw new Error('HTTP ' + r.status + why)"));
// a query loads on its FIRST READ (a store's used to start at app boot, before any session: a 401 that stuck), a
// refetch that comes first marks it started (no bare load on top), and a first load already in flight is shared
ok('a query starts on its first read', js.includes('sig.get = () => { if (!sig.__started) { sig.__started = true;'));
ok('a refetch marks the query started', js.includes('sig.__started = true; const tok = (sig.__tok'));
ok('a first load shares an identical GET in flight, app-wide', js.includes('return __shared(q.url, init)') && js.includes('globalThis.__mutenFlight'));
ok('a GET query starts from the last rows it showed (stale-while-revalidate)', js.includes('const __hit = __cache.get(sig.__key); if (__hit) sig.set({ data: __hit, loading: false, error: null }); __remember(sig);'));
ok('the cache is keyed with the session headers and bounded', js.includes('function __cacheKey(url) { return JSON.stringify([url, __hdrs(url)]); }') && js.includes('if (__cache.size > 50)'));
ok('the key is taken again when the request leaves (a store query is created before any session)', js.includes('if (sig.__key) sig.__key = __cacheKey(__src.url);'));
ok('actions are generated', js.includes('function buy(item)') && js.includes('function drop(item)'));

// The emitted __crud, run for real against a fake server that answers late. The bug it exists for: a
// switch tapped three times jumped back when the first, older reply landed on top of the newest tap.
const crudSrc = js.slice(js.indexOf('const __book = {};'), js.indexOf('function __refetch('));
const runCrud = async (script) => {
  const sent = []; const waiting = [];
  const fakeWrite = (name, method, id, body) => new Promise((res, rej) => { sent.push({ method, id, body }); waiting.push({ res, rej, method, body }); });
  let seq = 0; const fakeId = () => 'tmp-' + (++seq);
  const make = new Function('__write', '__id', crudSrc + '; return __crud;');
  const crud = make(fakeWrite, fakeId);
  let rows = [];
  const list = { get: () => rows, set: (d) => { rows = d; } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const answer = async (n, row) => { await tick(); waiting[n].res(row); await tick(); };
  const fail = async (n) => { await tick(); waiting[n].rej(new Error('HTTP 500')); await tick(); };
  await script({ crud: (m, item) => crud('rows', m, item, list.get, list.set).catch(() => {}), rows: () => rows, sent, answer, fail });
};
await runCrud(async ({ crud, rows, sent, answer }) => {
  crud('POST', { kind: 'hours', active: false });
  ok('crud: create shows at once', rows().length === 1 && rows()[0].active === false);
  crud('PUT', { ...rows()[0], active: true });
  ok('crud: a tap during the create shows at once', rows()[0].active === true);
  crud('PUT', { ...rows()[0], active: false });
  ok('crud: a third tap shows at once', rows()[0].active === false);
  await new Promise((r) => setTimeout(r, 0));
  ok('crud: the PUTs wait for the create (one request in flight)', sent.length === 1);
  await answer(0, { id: 'srv-1', kind: 'hours', active: false });
  ok('crud: the old create reply does not overwrite the newest tap', rows()[0].active === false && rows().length === 1);
  ok('crud: the queued PUT goes to the server id', sent.length === 2 && sent[1].method === 'PUT' && sent[1].id === 'srv-1' && sent[1].body.id === 'srv-1');
  ok('crud: queued taps coalesce into ONE PUT carrying the last value', sent.length === 2 && sent[1].body.active === false);
  await answer(1, { id: 'srv-1', kind: 'hours', active: false });
  ok('crud: the latest reply settles the row (server id)', rows().length === 1 && rows()[0].id === 'srv-1' && rows()[0].active === false);
});
await runCrud(async ({ crud, rows, sent, answer }) => {
  crud('POST', { id: 'b', kind: 'x', title: 'old', on: false });
  await answer(0, { id: 'b', kind: 'x', title: 'old', on: false });
  crud('PUT', { id: 'b', on: true });
  await new Promise((r) => setTimeout(r, 0));
  crud('PUT', { id: 'b', title: 'new' });
  crud('PUT', { id: 'b', on: false });
  await new Promise((r) => setTimeout(r, 0));
  ok('crud: an in-flight PUT is not merged into', sent.length === 2 && sent[1].body.on === true);
  await answer(1, { id: 'b', kind: 'x', title: 'old', on: true });
  ok('crud: an older PUT reply does not overwrite the newest tap', rows()[0].on === false && rows()[0].title === 'new');
  ok('crud: coalesced PUT keeps every field of the skipped ones', sent.length === 3 && sent[2].body.title === 'new' && sent[2].body.on === false);
  await answer(2, { id: 'b', kind: 'x', title: 'new', on: false });
  ok('crud: settles on the server row', rows()[0].title === 'new' && rows()[0].on === false);
});
await runCrud(async ({ crud, rows }) => {
  crud('POST', { id: 'r1', kind: 'hours', title: 'hours', active: true });
  crud('PUT', { id: 'r1', active: false });
  ok('crud: a partial update keeps the fields it did not send', rows()[0].kind === 'hours' && rows()[0].title === 'hours' && rows()[0].active === false);
});
await runCrud(async ({ crud, rows, fail }) => {
  crud('POST', { kind: 'a' });
  await fail(0);
  ok('crud: a failed create removes its row', rows().length === 0);
});
await runCrud(async ({ crud, rows, answer, fail }) => {
  crud('POST', { kind: 'a', on: false });
  await answer(0, { id: 's', kind: 'a', on: false });
  crud('PUT', { ...rows()[0], on: true });
  await fail(1);
  ok('crud: a failed latest PUT restores that row', rows()[0].on === false);
  crud('DELETE', rows()[0]);
  ok('crud: delete drops at once', rows().length === 0);
  await fail(2);
  ok('crud: a failed delete puts the row back', rows().length === 1 && rows()[0].id === 's');
});

// write status: an action that writes is async and exposes reactive .pending / .error
const sjs = compileModule(toDoc(parse(`screen s
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders" } }
action buy mutates orders <- item { orders.create(item) }
Page { when buy.pending { Text "Saving" } when buy.error { Text "{buy.error}" } each orders as o { Text "{o.title}" } }`)));
ok('write action is async', sjs.includes('function buy(item) { return untrack(async () =>'));
// An action never subscribes the effect that calls it (an effect calling notice.error re-ran itself for ever).
ok('actions run untracked (and untrack is imported)', sjs.includes('untrack') && /import \{[^}]*\buntrack\b/.test(sjs));
ok('write is awaited', sjs.includes('await __crud("orders", \'POST\', item,'));
ok('.pending / .error signals declared', sjs.includes('const __pending_buy = signal(false)') && sjs.includes('const __error_buy = signal(null)'));
ok('pending toggles around the write', sjs.includes('__pending_buy.set(true)') && sjs.includes('__pending_buy.set(false)'));
ok('failure captured to .error', sjs.includes('__error_buy.set(String(__e))'));
ok('buy.pending resolves to the signal', sjs.includes('__pending_buy.get()'));

// refetch: re-run a query with N query-string params (pagination / search / filters), any web-app
const rjs = compileModule(toDoc(parse(`screen r
entity Product { title text }
state { q = "" : text  page = 1 : number  products = query products : list<Product> }
sources { products: { url: "/products", at: "data" } }
action apply mutates products <- term { products.refetch(q: term, page: page, sort: "new") }
Page { SearchField bind(q)  Button "Go" -> apply(q)  each products as o { Text "{o.title}" } }`)));
ok('refetch builds N params (input+state+literal)', rjs.includes('__refetch("products", { "q": term, "page": page.get(), "sort": "new" }, products)'));
ok('refetch stays sync (a read, not a write)', rjs.includes('function apply(term)') && !rjs.includes('async function apply'));
ok('__refetch helper emitted', rjs.includes('function __refetch(name, params, sig)'));
ok('__refetch url-encodes params', rjs.includes('encodeURIComponent(params[k])'));
// The first load of a query must not land over a refetch that started after it (slow network: the bare request
// answered after the keyed one had begun, cleared `loading` and drew «not found»). Both sides use sig.__tok.
// A failed request says WHY, not only the status: «HTTP 409 card-policy-required». The status stays first, so a
// screen that reads only the number still does; one that knows the server's code can say the right thing.
ok('a failed request carries the server\'s error code after its status', rjs.includes("throw new Error('HTTP ' + r.status + why)") && rjs.includes("typeof j.error === 'string'"));
ok('first load drops its answer once a refetch took over', rjs.includes('const tok = sig.__tok || 0; __fetch(name)') && rjs.includes('if ((sig.__tok || 0) === tok) sig.set({ data: d, loading: false'));

// refetch when the STATE name differs from the SOURCE name: the lookup key must be the SOURCE (__SOURCES is
// keyed by source), the update target the state signal. Previously refetch emitted the state name -> undefined
// source -> the query silently never refreshed.
const rjs2 = compileModule(toDoc(parse(`screen r2
entity Row { name text }
state { items = query listRows : list<Row> }
sources { listRows: { url: "/rows", at: "data" } }
action reload mutates items { items.refetch() }
Page { Button "Reload" -> reload  each items as o { Text "{o.name}" } }`)));
ok('refetch resolves the SOURCE name, updates the STATE signal', rjs2.includes('__refetch("listRows", {  }, items)'));
ok('refetch does NOT key off the state name', !rjs2.includes('__refetch("items"'));

// explicit non-REST request (escape hatch): post/put/delete with a client prefix + interpolated url + body
const ejs = compileModule(toDoc(parse(`screen e
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders" } }
action buy <- item { post "shop:/orders" body item }
action cancel <- o { delete "shop:/orders/{o.id}/cancel" }
Page { each orders as x { Text "{x.title}" } }`)), {}, '', {}, { orders: { url: '/orders' } }, { api: { shop: { base: 'http://x' } } });
ok('explicit post + body', ejs.includes('await __send("shop:/orders", "POST", item)'));
// the id is spliced as ONE path segment (__seg): `../admin` cannot climb to another endpoint with the user's session
ok('explicit delete + interpolated url', ejs.includes('await __send("shop:/orders/" + __seg(o.id) + "/cancel", "DELETE", null)'));
ok('explicit request → async (a write)', ejs.includes('function buy(item) { return untrack(async () =>'));
ok('pure command needs no mutates (.pending wired)', ejs.includes('__pending_buy'));
ok('__send helper emitted', ejs.includes('function __send(url, method, body)'));

// scalar-list toggle (membership): `favs.toggle(x)` adds x if absent, removes if present — the toggle-OFF
// a scalar `remove where` can't express. (Unblocks favorites/subscribe; was add-only before.)
const tjs = compileModule(toDoc(parse(`screen s
state { favs = [] : list<text> }
action fav(x: text) mutates favs { favs.toggle(x) }
action openClose mutates open { open.toggle() }
state { open = false : bool }
Page { Button "f" -> fav("v1")  when favs contains "v1" { Text "on" } }`)));
ok('scalar toggle: add-if-absent / remove-if-present', tjs.includes('__l.includes(__v) ? __l.filter((__e) => __e !== __v) : [...__l, __v]'));
ok('bool toggle still flips', tjs.includes('open.set(!open.get());'));

// page-level `effect {}` runs on mount: a local mutation AND a store-action call both compile into effect().
const fjs = compileModule(toDoc(parse(`screen s
state { current = "x" : text }
effect { current.set("y") }
effect { ui.setSection("home") }
Page { Button "f" -> ui.setSection("a")  Text "c {current}" }`)));
ok('page effect: local mutation emitted', fjs.includes('effect(() => {') && fjs.includes('current.set("y")'));
ok('page effect: store-action call emitted', fjs.includes('__store_ui.setSection("home")'));
ok('page effect: store imported from the effect', fjs.includes("import * as __store_ui from 'virtual:muten/store/ui'"));

// post … into <state>: capture the JSON response (order id / confirmation code) into a local state.
const ijs = compileModule(toDoc(parse(`screen e
entity Receipt { code text }
state { receipt = {} : Receipt }
sources { receipt: { url: "/r" } }
action pay <- cart { post "/checkout" body cart into receipt }
Page { Text "{receipt.code}" }`)), {}, '', {}, {}, { api: {} });
ok('post into → captures the response into the state', ijs.includes('receipt.set(await __send("/checkout", "POST", cart))'));
ok('post-into action is async (awaits the response)', ijs.includes('function pay(cart) { return untrack(async () =>'));
const ibad = compileModule(toDoc(parse(`screen e
state { x = "" : text }
action pay <- c { post "/c" body c }
Page { Button "go" -> pay(x)  Text "{x}" }`)), {}, '', {}, {}, { api: {} });
ok('plain post (no into) does NOT capture a response', ibad.includes('__send("/c", "POST", c)') && !ibad.includes('.set(await __send') && !ibad.includes('.then((__r)'));

// dynamic sort column: `sort by <text-state>` -> __it[state.get()] (user-chosen column); a literal field stays static.
const djs = compileModule(toDoc(parse(`screen s
entity Row { name text  price number }
state { rows = [] : list<Row>  sortCol = "price" : text }
get sorted = rows.sortDesc by sortCol
Page { each sorted as r { Text "{r.name}" } }`)));
ok('dynamic sort key reads __it[stateValue]', djs.includes('__it[sortCol.get()]'));
const sjs2 = compileModule(toDoc(parse(`screen s
entity Row { name text  price number }
state { rows = [] : list<Row> }
get sorted = rows.sortDesc by price
Page { each sorted as r { Text "{r.name}" } }`)));
ok('literal field sort stays static (__it.price)', sjs2.includes('__it.price') && !sjs2.includes('__it[price'));

// persist keys are namespaced by SCOPE (store domain / page screen) so two stores with the same state name
// (`items`) don't share one localStorage key — the silent cross-store data bleed found in the Pulse dashboard.
const storeA = parse('state { items = [] : list<text> persist }');
const sA = compileStore({ state: storeA.state, domain: 'orders' });
const sB = compileStore({ state: storeA.state, domain: 'customers' });
ok('store persist key namespaced by domain (orders)', sA.includes('"muten:orders:items"'));
ok('store persist key namespaced by domain (customers)', sB.includes('"muten:customers:items"') && !sB.includes('"muten:items"'));
const pPage = compileModule(toDoc(parse('screen home\nstate { draft = "" : text persist }\nPage { Text "{draft}" }')));
ok('page persist key namespaced by screen', pPage.includes('"muten:home:draft"'));

// `list.take(n)` -> the first n items (top-N / "load more" pagination). Returns a list of the same element.
const tkjs = compileModule(toDoc(parse('screen s\nentity P { t text }\nstate { posts = [] : list<P>  limit = 3 : number }\nget top = posts.take(limit)\nPage { each posts.take(2) as p { Text "{p.t}" } }')));
ok('take(n) literal compiles to slice(0, n)', tkjs.includes('.slice(0, 2)'));
ok('take(state) compiles to slice(0, state.get())', tkjs.includes('.slice(0, limit.get())'));

// Inline editing of a QUERY row: a text input `bind(x.field)` over a query-backed list edits the server row in
// place — patch `.data` locally on `input` (instant, caret-safe), persist with a PUT on `change` (blur),
// reconcile/revert like `list.update`. Non-text inputs over a query row stay read-only (no regression).
const rowEdit = compileModule(toDoc(parse(`screen s
entity Msg { name text  body text  done bool }
state { msgs = query msgs : list<Msg> }
sources { msgs: { url: "/msgs" } }
Page { each msgs as m { SearchField bind(m.name) "n"  Textarea bind(m.body) "b"  Checkbox bind(m.done) } }`)));
ok('query row: commits (patch .data) on change', rowEdit.includes('data: __next') && rowEdit.includes('__r && __r.id === m.get().id ? { ...__r, ["name"]: __v }'));
ok('query row: commit runs on change (blur), never on input', rowEdit.includes(".addEventListener('change', async (e) =>") && !rowEdit.includes(".addEventListener('input'"));
ok('query row: persists with a PUT', rowEdit.includes('__write("msgs", \'PUT\', __row.id, __row)'));
ok('query row: reconciles with the server row', rowEdit.includes('__r && __r.id === __row.id ? __srv : __r'));
ok('query row: reverts on failure', rowEdit.includes('data: __prev'));
ok('query row: __write prelude included', rowEdit.includes('function __write(name, method, id, body)'));
// a non-text input (Checkbox) over the query row must NOT get a text write path — it stays read-only.
ok('query row: Checkbox stays read-only (only the 2 text inputs PUT)', (rowEdit.match(/__write\("msgs", 'PUT'/g) || []).length === 2);

// A SETTABLE local list keeps its old inline patch (no __write, no change listener) — unchanged behavior.
const localEdit = compileModule(toDoc(parse(`screen s
entity Todo { title text }
state { rows = [] : list<Todo> }
Page { each rows as x { SearchField bind(x.title) "t" } }`)));
ok('settable local row still patches the signal on input', localEdit.includes("addEventListener('input', (e) => rows.set((rows.get() || []).map("));
ok('settable local row does NOT PUT', !localEdit.includes("'PUT'"));

// A store reading and calling ANOTHER store (auth.store sending `ui.lang` and calling `ui.setLang`). Without the
// other stores' map, `ui.lang` compiled to a bare `ui.lang` and `__store_ui` was never imported: the action threw
// ReferenceError before its `post` left, and sign-up read it as «no connection».
const authIr = parse(`state { token = "" : text }
action signUp(mail: text) mutates token {
  post "/auth/register" body { email: mail, lang: ui.lang } into token
  ui.setLang("es")
}`);
const uiMeta = { ui: { state: ['lang'], gets: [], actions: ['setLang'], queries: [] } };
const authJs = compileStore({ state: authIr.state, actions: authIr.actions, domain: 'auth', stores: { ...uiMeta, auth: { state: ['token'], gets: [], actions: ['signUp'], queries: [] } } });
ok('a store reads another store\'s state through its import', authJs.includes('__store_ui.lang.get()') && !/[^_]ui\.lang/.test(authJs));
ok('a store imports the other stores it uses', authJs.includes("import * as __store_ui from 'virtual:muten/store/ui'"));
ok('a store never imports itself', !authJs.includes("virtual:muten/store/auth'"));

// a `get` that reads an action's `.pending` is a computed evaluated as soon as it is created, so the action's
// signals must already exist: they used to be declared with the actions, AFTER the gets, and the page threw
// «Cannot access '__pending_save' before initialization» on mount while `muten check` stayed green.
const pendJs = compileModule(toDoc(parse(`screen shop
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders", at: "data" } }
action save mutates orders <- item { orders.create(item) }
get saving = save.pending or orders.loading
Page { when saving { Text "…" } }`)));
const pendAt = pendJs.indexOf('const __pending_save = signal(false)');
const getAt = pendJs.indexOf('const saving = computed(');
ok('an action\'s .pending signal is declared before a get that reads it', pendAt >= 0 && getAt > pendAt, `pending@${pendAt} get@${getAt}`);
ok('the .pending signal is declared once', pendJs.split('const __pending_save = signal(false)').length === 2);

// `} failed { … }`: what an action does when its request fails, right where the request is (it was only `name.error`)
{
  const src = 'screen s\nstate { n = 0 : number  problem = "" : text }\naction save mutates problem {\n  post "/x" body n\n} failed {\n  problem.set("no")\n}\nPage { Button "Save" -> save }';
  const ir = parse(src);
  ok('failed parses as its own block', ir.actions.save.failed?.length === 1 && ir.actions.save.body.length === 1, JSON.stringify(ir.actions.save));
  const js = compileModule(toDoc(ir));
  ok('failed runs in the catch, after .error is set', /catch \(__e\) \{\s*__error_save\.set\(String\(__e\)\);\s*problem\.set\("no"\);\s*\}/.test(js), js.match(/catch[\s\S]{0,120}/)?.[0]);
  const local = compileModule(toDoc(parse('screen s\nstate { a = 0 : number  problem = "" : text }\naction bump mutates a, problem {\n  a.set(a + 1)\n} failed {\n  problem.set("no")\n}\nPage { Button "+" -> bump }')));
  ok('an action with failed has .pending/.error even with no request', local.includes('const __error_bump = signal(null)'));
  const { validate } = await import('#engine/ir/validate.js');
  const bad = validate(toDoc(parse(src.replace('problem.set("no")', 'problm.set("no")')))).diagnostics.map((d) => d.code);
  ok('the failed block is checked like the body', bad.length > 0, bad.join(','));
  const { print } = await import('#engine/ir/print.js');
  ok('print keeps the failed block', print(ir).includes('} failed {'), print(ir));
}

// `x.send(…)` goes up the socket of a `query x live`; it changes nothing here, so it needs no `mutates`
{
  const { validate } = await import('#engine/ir/validate.js');
  const base = 'screen s\nentity M { name text }\nstate { msgs = query feed live : list<M>  local = [] : list<M> }\nsources { feed: "/live" }\n';
  const codes = (action) => validate(toDoc(parse(base + action + '\nPage { Button "s" -> say }'))).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  ok('send on a live query needs no mutates', codes('action say { msgs.send({ name: "x" }) }').length === 0, codes('action say { msgs.send({ name: "x" }) }').join(','));
  ok('send on a list that is not live is an error', codes('action say { local.send({ name: "x" }) }').includes('send-not-live'));
  const js = compileModule(toDoc(parse(base + 'action say { msgs.send({ name: "x" }) }\nPage { Button "s" -> say }')));
  ok('send compiles to the socket', js.includes('msgs.__send({ "name": "x" })'), js.match(/msgs\.__send[^\n]*/)?.[0]);
  ok('a live message can upsert/remove rows (the data layer carries __live)', js.includes('function __live('));
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
