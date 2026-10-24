// Packages from npm used straight from a page: their own API (methods, chains, default exports), the shapes the big
// SDKs answer with, and the packages that must never reach the browser. The lab that runs these against real SDKs in
// Chrome lives outside the repo; this pins the compiler's side of it.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { print } from '#engine/ir/print.js';
import { compileModule, compile } from '#engine/compile/compile.js';
import { withUseTypes } from '#engine/project/npm-types.js';
import { serverOnly } from '#engine/project/server-packages.js';
import { nativeWebOptions } from '#engine/project/native-web.js';
import { packageTypeDiagnostics } from '#engine/project/ts-check.js';
import { loadTypeScript, typeOracle } from '#engine/project/type-oracle.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const page = (body) => toDoc(parse(`screen p\n${body}`));
const codes = (body) => validate(page(body), {}).diagnostics.map((d) => d.code);
const js = (body) => compileModule(page(body), {}, '', {}, {}, {});

// ── a package's own API ──
const supa = 'use createClient from "@supabase/supabase-js"\nentity Order { total number }\nget db = createClient("https://x.supabase.co", "anon")\nstate { orders = query db.from("orders").select("*").eq("shop", 1) : list<Order>  n = 3 : number }\naction add() { db.from("orders").insert({ total: n }) }\nPage { each orders as o { Text "{o.total}" } Button "+" -> add }';
ok('a chain on what a package gave back checks clean', codes(supa).length === 0, codes(supa).join());
const supaJs = js(supa);
ok('the query asks through the object, so the method keeps its `this`', supaJs.includes('() => db.get().from("orders").select("*").eq("shop", 1)'), supaJs.match(/__callQuery\([^\n]*/)?.[0]);
ok('it is created after the get it reads', supaJs.indexOf('const db = computed') < supaJs.indexOf('const orders = __callQuery'));
ok('a chain as a statement is awaited in its action', supaJs.includes('await db.get().from("orders").insert({ "total": n.get() });'), supaJs.match(/function add[\s\S]*?\}\); \}/)?.[0]);
ok('a method on an imported object (posthog.capture)', codes('use posthog from "posthog-js"\naction buy() { posthog.capture("buy") }\nPage { Button "x" -> buy }').length === 0);
ok('a chain on a call (zod), live in a get', js('use z from "zod"\nstate { email = "" : text }\nget ok = z.string().email().safeParse(email).success\nPage { Text "{ok}" }').includes('z.string().email().safeParse(email.get()).success'));
ok('a property step reads without a call', print(parse('screen p\nuse z from "zod"\nget ok = z.string().safeParse("a").success\nPage { Text "{ok}" }')).includes('z.string().safeParse("a").success'));
ok('print keeps a query chain', print(parse(`screen p\n${supa}`.replace('screen p\nscreen p', 'screen p'))).includes('query db.from("orders").select("*").eq("shop", 1)'));

// ── what stays forbidden: muten values have no methods ──
ok('a method on a muten text', codes('state { name = "" : text }\nPage { Text "{name.toUpperCase()}" }').includes('no-methods'));
ok('a chain on a built-in', codes('state { n = 1 : number }\nPage { Text "{money(n).trim()}" }').includes('no-methods'));
ok('a method on a parenthesized value is still a parse error', (() => { try { parse('screen p\nstate { n = 1 : number }\nPage { Text "{(n * 2).toFixed(0)}" }'); return false; } catch { return true; } })());
ok('a statement on a name nobody `use`d', codes('action go() { analytics.track("x") }\nPage { Button "x" -> go }').length > 0);

// ── how a package comes in ──
const conf = js('use confetti from "canvas-confetti"\naction party() { confetti() }\nPage { Button "x" -> party }');
ok('a single name falls back to the default export (canvas-confetti, posthog-js)', conf.includes('const confetti = __pkg_0.confetti ?? __pkg_0.default?.confetti ?? __pkg_0.default;'), conf.match(/const confetti[^\n]*/)?.[0]);
const many = js('use format, addDays from "date-fns"\nPage { Text "{format(addDays(now(), 1), "P")}" }');
ok('several names look on the default export, never become it', many.includes('const addDays = __pkg_0.addDays ?? __pkg_0.default?.addDays;'), many.match(/const addDays[^\n]*/)?.[0]);
ok('the app\'s own file is imported by name, as written', js('use fmt from "~/lib/fmt.ts"\nPage { Text "{fmt(1)}" }').includes('import { fmt } from "~/lib/fmt.ts";'));

// ── what a package gave back, with no type ──
const opaque = 'use loadStripe from "@stripe/stripe-js"\nstate { stripe = query loadStripe("pk_test") }\nPage { Text "{stripe.loading} {stripe.elements}" }';
ok('a query of a function with no type holds it as it is, members unchecked', codes(opaque).length === 0, codes(opaque).join());
ok('a field of what has not arrived yet reads empty instead of throwing', js('use watch from "pkg"\nstate { one = query watch("x") live }\nPage { Text "{one.total}" }').includes('one.get().data?.total'));

// ── the runtime: the shapes SDKs answer with ──
const runtime = js('use lookup from "pkg"\nstate { q = "" : text  hits = query lookup(q) }\nPage { Text "{hits.loading}" }');
ok('{ data, error } (Supabase) and Firestore snapshots are read as rows', runtime.includes("'data' in v && 'error' in v") && runtime.includes('v.docs.map((d) => ({ id: d.id, ...d.data() }))'));

// ── never in the browser ──
const app = mkdtempSync(join(tmpdir(), 'muten-sdk-'));
for (const [name, manifest, entry] of [['nodey', { main: 'index.js' }, 'const http = require("http");'], ['webby', { main: 'index.js', browser: 'web.js' }, 'const http = require("http");'], ['plain', { main: 'index.js' }, 'export const x = 1;']]) {
  mkdirSync(join(app, 'node_modules', name), { recursive: true });
  writeFileSync(join(app, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...manifest }));
  writeFileSync(join(app, 'node_modules', name, 'index.js'), entry);
}
ok('a known server SDK says what the app uses instead', serverOnly('stripe', app).includes('@stripe/stripe-js') && serverOnly('openai', app).includes('secret key'));
ok('an unknown package that needs Node and has no browser build', serverOnly('nodey', app).includes("Node's own modules"));
ok('one with a browser build, or plain code, is fine', serverOnly('webby', app) === '' && serverOnly('plain', app) === '' && serverOnly('@stripe/stripe-js', app) === '');
const pageFile = join(app, 'src', 'pages', 'p', 'p.muten');
const guarded = withUseTypes(parse('screen p\nuse Stripe from "stripe"\nPage { Text "x" }'), pageFile, app);
const found = validate(toDoc(guarded), {}).diagnostics.find((d) => d.code === 'server-package');
ok('check stops a server SDK at its `use` line', found?.loc?.line === 2, JSON.stringify(found));

// ── live feeds: a package's subscription, with `change` where its callback goes ──
const realtime = 'use createClient from "@supabase/supabase-js"\nentity Order { total number }\nget db = createClient("https://x.supabase.co", "anon")\nstate {\n  orders = query db.from("orders").select("*")\n    live db.channel("orders").on("postgres_changes", { event: "*", table: "orders" }, change).subscribe()\n    : list<Order>\n}\nPage { each orders as o { Text "{o.total}" } }';
ok('a channel subscription after the query checks clean', codes(realtime).length === 0, codes(realtime).join());
const realtimeJs = js(realtime);
ok('it opens once with muten\'s callback, after the get it reads', realtimeJs.includes('__feed(orders, true, (change) => db.get().channel("orders").on("postgres_changes", { "event": "*", "table": "orders" }, change).subscribe());') && realtimeJs.indexOf('const db = computed') < realtimeJs.indexOf('__feed(orders'), realtimeJs.match(/__feed\(orders[^\n]*/)?.[0]);
ok('the runtime applies Supabase change events and stops a channel by unsubscribe()', realtimeJs.includes("v.eventType === 'DELETE'") && realtimeJs.includes("typeof stop.unsubscribe === 'function'"));
ok('print keeps the feed', print(parse(`screen p\n${realtime}`)).includes('live db.channel("orders").on("postgres_changes", { event: "*", table: "orders" }, change).subscribe()'));
ok('a plain list state may be fed too (socket.on)', codes('use io from "socket.io-client"\nentity Msg { text text }\nget socket = io("https://x")\nstate { messages = [] : list<Msg> live socket.on("msg", change) }\nPage { each messages as m { Text "{m.text}" } }').length === 0);
ok('a feed that never passes change is named', codes('use io from "socket.io-client"\nget socket = io("https://x")\nstate { n = 0 : number live socket.on("msg", other) }\nPage { Text "{n}" }').includes('live-no-change'));
ok('a feed must be a package\'s subscription', codes('state { n = 0 : number live n.on("x", change) }\nPage { Text "{n}" }').includes('live-feed'));
ok('a bare `live` before the next state is still the socket form', page('state {\n  feed = query feed live : list<text>\n  n = 0 : number\n}\nsources { feed: "wss://x" }\nPage { Text "{n}" }').state.feed.live === true);

// ── leaving for a Checkout page ──
const pay = js('entity Session { url text }\nstate { session = {} : Session }\naction checkout() mutates session { post "/checkout" body { plan: "pro" } into session\n visit(session.url) }\nPage { Button "Pagar" -> checkout }');
ok('visit() goes where the API said, after the post answered', /session\.set\(await [^;]+;\s*__b_visit\(session\.get\(\)\?\.url\);/.test(pay), pay.match(/function checkout[\s\S]*?\}\); \}/)?.[0]);
ok('visit() is guarded like every address built from data', /function __b_visit\(url\) \{ const u = __safeUrl\(url\)/.test(pay));

// ── React Native libraries on the web, by installing react-native-web ──
ok('no react-native-web: nothing changes', Object.keys(nativeWebOptions(app)).length === 0);
mkdirSync(join(app, 'node_modules', 'react-native-web'), { recursive: true });
writeFileSync(join(app, 'node_modules', 'react-native-web', 'package.json'), '{"name":"react-native-web"}');
const rn = nativeWebOptions(app);
ok('with it, react-native is react-native-web, .web files first, RN globals defined', rn.alias?.['react-native'] === 'react-native-web' && rn.resolveExtensions?.[0] === '.web.tsx' && rn.define?.__DEV__ === 'false');

// ── calls into a package, checked by TypeScript against the package's own types ──
mkdirSync(join(app, 'node_modules', 'typed-sdk'), { recursive: true });
writeFileSync(join(app, 'node_modules', 'typed-sdk', 'package.json'), '{"name":"typed-sdk","types":"index.d.ts","main":"index.js"}');
writeFileSync(join(app, 'node_modules', 'typed-sdk', 'index.d.ts'), 'export interface Query { select(columns: string): Query; eq(column: string, value: unknown): Query }\nexport interface Client { from(table: string): Query }\nexport declare function createClient(url: string, key: string): Client;\nexport declare class Chart { constructor(id: string, config: object); destroy(): void }');
const typedPage = (body) => toDoc(withUseTypes(parse(`screen p\nuse createClient, Chart from "typed-sdk"\nget db = createClient("https://x", "k")\n${body}\nPage { Text "x" }`), pageFile, app));
const typeCodes = (body) => (packageTypeDiagnostics([{ file: pageFile, doc: typedPage(body) }], app).get(pageFile) || []).map((d) => d.message.split(': ')[1]?.split(' (')[0]);
ok('TypeScript is there to ask (muten brings it)', !!loadTypeScript(app));
// type-oracle: the one place muten asks TypeScript; one per app, reused, and its findings are plain data
const oracle = typeOracle(app);
ok('the app has one oracle, kept for the process', !!oracle && typeOracle(app) === oracle);
const oracleFile = join(app, 'src', '__oracle_probe.ts');
const said = oracle ? oracle.check(new Map([[oracleFile, 'const n: number = "text";']])) : [];
ok('the oracle reports a type error with its place and code', said.some((f) => f.file === oracleFile && f.code === 2322 && f.line === 0 && f.col === 6));
ok('a second check reuses the oracle and still answers', !!oracle && oracle.check(new Map([[oracleFile, 'const n: number = 1;']])).length === 0);
ok('a chain the package has is clean', typeCodes('get rows = db.from("orders").select("*").eq("shop", 1)').length === 0, typeCodes('get rows = db.from("orders").select("*").eq("shop", 1)').join());
ok('a method it lacks, with its closest', typeCodes('get rows = db.from("orders").selct("*")').join().includes("Property 'selct' does not exist on type 'Query'. Did you mean 'select'?"), typeCodes('get rows = db.from("orders").selct("*")').join());
ok('a call with too many values', typeCodes('action go() { db.from("a", "b") }').join().includes('Expected 1 arguments, but got 2'), typeCodes('action go() { db.from("a", "b") }').join());
ok('new on a class it exports, and a method of what it made', typeCodes('effect { new Chart("sales", {}).destroy() }').length === 0 && typeCodes('effect { new Chart("sales", {}).destory() }').join().includes("'destory'"));
ok('it points at the line that has it', (packageTypeDiagnostics([{ file: pageFile, doc: typedPage('get rows = db.from("orders").selct("*")') }], app).get(pageFile) || [])[0]?.loc?.line === 4);

// ── muten build keeps a page's effects ──
const html = compile(page('use init from "pkg"\neffect { init("x") }\nstate { n = 0 : number }\nPage { Text "{n}" }'), {}, '', {}, {}, {});
ok('a built page runs its effect (an SDK set up on load)', html.includes('init("x")'));

if (f) { console.log(`\n✗ ${f} failed`); process.exit(1); }
console.log('\n✓ sdk: all passed');
