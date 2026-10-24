// Route params: a `/product/:id` route pattern + a page's `param id` declaration, injected at mount.
// Verifies the full pipeline (parse → flatten → validate → compile) treats a param as a read-only
// local string — distinct from reactive state — without masking typos.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule } from '#engine/compile/compile.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

// 1. route paths keep their :param segments (and static segments around them)
const app = parse('routes {\n  "/" -> home\n  "/shop/:cat/item/:id" -> item\n}');
ok('route :param segments parsed', app.routes[1].url === '/shop/:cat/item/:id', app.routes[1].url);
ok('static root route intact', app.routes[0].url === '/', app.routes[0].url);

// 2. the page declares its params
const page = parse('screen item\nparam cat\nparam id\nstate { qty = 1 : number }\naction more mutates qty { qty.set(qty + 1) }\nPage {\n  Title "{cat} / {id}"\n  Text "qty {qty}"\n  Button "+" -> more\n}');
ok('page declares both params', JSON.stringify(page.params) === '["cat","id"]', JSON.stringify(page.params));

// 3. params survive flatten and validate as known refs (no false "unknown ref")
const doc = toDoc(page);
ok('doc carries params', JSON.stringify(doc.params) === '["cat","id"]', JSON.stringify(doc.params));
const v = validate(doc, {});
ok('param refs validate clean', v.ok, v.diagnostics.map((d) => d.message).join(' | '));

// 4. compile: mount receives params; each is a local string; state stays a reactive signal
const js = compileModule(doc);
ok('mount(app, __params)', js.includes('mount(app, __params)'));
ok('cat const from __params', js.includes('const cat = (__params || {})["cat"]'));
ok('id const from __params', js.includes('const id = (__params || {})["id"]'));
ok('param used as plain string (no .get())', js.includes("String(cat ?? '')") && js.includes("String(id ?? '')"));
ok('state still uses .get()', js.includes('qty.get()'));

// 5. params don't mask typos: an undeclared ref still errors
ok('undeclared ref still flagged', !validate(toDoc(parse('screen item\nparam id\nPage { Text "{nope}" }')), {}).ok);

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
