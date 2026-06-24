// Server CRUD: create/update/delete on a source-backed list compile to __write (POST/PUT/DELETE) + a
// reactive update of the list. The HTTP request is built by sourceRequest (live-verified in test/ssr.ts);
// here we lock the generated shape — method, url (/:id), body, error handling, and the list mutation.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compileModule } from '#engine/compile/compile.js';

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

ok('create → POST to collection', js.includes('__write("orders", \'POST\', null, __i)'));
ok('create appends optimistically (temp id)', js.includes('[...__prev, __i]') && js.includes('if (__i.id == null) __i.id = __id()'));
ok('create reconciles with the server row', js.includes('.map((__x) => __x.id === __i.id ? __r : __x)'));
ok('update → PUT by id', js.includes('__write("orders", \'PUT\', __i.id, __i)'));
ok('update replaces by id', js.includes('.map((__x) => __x.id === __i.id ? __r : __x)'));
ok('delete → DELETE by id', js.includes('__write("orders", \'DELETE\', __i.id, null)'));
ok('delete drops by id (optimistic)', js.includes('.filter((__x) => __x.id !== __i.id)'));
ok('reverts to the snapshot on failure', js.includes('data: __prev'));
ok('write failure captured to action .error', js.includes('__error_buy.set(String(__e))'));
ok('__write helper emitted', js.includes('function __write(name, method, id, body)'));
ok('__write JSON-encodes the body', js.includes('init.body = JSON.stringify(body)'));
ok('__write appends /:id', js.includes('encodeURIComponent(id)'));
ok('__write throws on !ok', js.includes("if (!r.ok) throw new Error('HTTP '"));
ok('actions are generated', js.includes('function buy(item)') && js.includes('function drop(item)'));

// write status: an action that writes is async and exposes reactive .pending / .error
const sjs = compileModule(toDoc(parse(`screen s
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders" } }
action buy mutates orders <- item { orders.create(item) }
Page { when buy.pending { Text "Saving" } when buy.error { Text "{buy.error}" } each orders as o { Text "{o.title}" } }`)));
ok('write action is async', sjs.includes('async function buy(item)'));
ok('write is awaited', sjs.includes('await __write("orders", \'POST\', null, __i)'));
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

// explicit non-REST request (escape hatch): post/put/delete with a client prefix + interpolated url + body
const ejs = compileModule(toDoc(parse(`screen e
entity Order { title text }
state { orders = query orders : list<Order> }
sources { orders: { url: "/orders" } }
action buy <- item { post "shop:/orders" body item }
action cancel <- o { delete "shop:/orders/{o.id}/cancel" }
Page { each orders as x { Text "{x.title}" } }`)), {}, '', {}, { orders: { url: '/orders' } }, { api: { shop: { base: 'http://x' } } });
ok('explicit post + body', ejs.includes('await __send("shop:/orders", "POST", item)'));
ok('explicit delete + interpolated url', ejs.includes('await __send("shop:/orders/" + String(o.id) + "/cancel", "DELETE", null)'));
ok('explicit request → async (a write)', ejs.includes('async function buy(item)'));
ok('pure command needs no mutates (.pending wired)', ejs.includes('__pending_buy'));
ok('__send helper emitted', ejs.includes('function __send(url, method, body)'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
