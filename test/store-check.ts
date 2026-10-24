// What `muten check` says about .store files and declared types: a store is state + logic (no screen), is reached by
// its file name (so it must be a name), is defined once, its queries come from somewhere, and every type is real.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStores } from '#engine/project/load.js';
import { storeContext } from '#engine/project/context.js';
import { validateStoresAndGuards } from '#engine/project/check-app.js';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };

const app = mkdtempSync(join(tmpdir(), 'muten-stores-'));
mkdirSync(join(app, 'src', 'deep'), { recursive: true });
writeFileSync(join(app, 'src', 'app.muten'), 'routes { "/" -> home }');
const store = (name, body) => writeFileSync(join(app, 'src', name), body);
store('cart.store', 'state { items = [] : list<number> }\nget count = itmes.length\nPage { Text "x" }');
store('my-cart.store', 'state { n = 0 : number }');
store('feed.store', 'entity Post { title text }\nstate { posts = query posts : list<Post> }');
store('deep/feed.store', 'state { n = 0 : number }');
const irs = findStores(join(app, 'src'));
const found = validateStoresAndGuards(app, irs, storeContext(irs));
const has = (file, code) => found.some((d) => d.file.endsWith(file) && d.code === code);
ok('a Page tree in a store is an error, at its line', has('cart.store', 'store-has-ui') && found.find((d) => d.code === 'store-has-ui')?.loc?.line === 3, JSON.stringify(found.find((d) => d.code === 'store-has-ui')));
ok('a typo in a get is reported at the get\'s line', found.some((d) => d.code === 'unknown-ref' && d.loc?.line === 2), JSON.stringify(found.filter((d) => d.code === 'unknown-ref')));
ok('a store name with a dash is an error in its own file, with the name to use', has('my-cart.store', 'store-name') && found.find((d) => d.code === 'store-name')?.message.includes('myCart.store'));
ok('a query with no source and no mock is an error', has('feed.store', 'query-no-source'));
ok('two stores with the same name: the second is reported', found.some((d) => d.code === 'store-duplicate'));
rmSync(app, { recursive: true, force: true });

const codes = (src) => validate(toDoc(parse(src))).diagnostics.map((d) => d.code + (d.suggestion ? ':' + d.suggestion : ''));
ok('a misspelled type is caught with the right one', codes('screen s\nstate { n = 0 : numbr }\nPage { Text "a" }').includes('unknown-type:number'));
ok('lst<number> suggests list<number>', codes('screen s\nstate { n = [] : lst<number> }\nPage { Text "a" }').includes('unknown-type:list<number>'));
ok('an entity type is fine', codes('screen s\nentity U { n text }\nstate { u = null : U }\nPage { Text "{u.n}" }').length === 0);
ok('persist on a query is an error', codes('screen s\nentity U { n text }\nstate { u = query us : list<U> persist }\nsources { us: "/u" }\nPage { Text "a" }').includes('persist-query'));
ok('a dotted ref to no store names the stores', validate(toDoc(parse('screen s\nPage { Text "{auth.on}" }')), { stores: ['cart'] }).diagnostics[0]?.message.includes('stores: cart'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
