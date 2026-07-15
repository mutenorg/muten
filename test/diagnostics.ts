// Diagnostics: the compiler detects the error AND proposes the closest candidate.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { ParseError } from '#engine/shared/diagnostics.js';

let fails = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};
const diagsOf = (src, ctx = {}) => validate(toDoc(parse(src)), ctx).diagnostics;

// 2. @ref to a missing state → suggests the close state
{
  const d = diagsOf('screen t\nstate { search = "" : text }\nPage { SearchField bind @serch "x" }').find((x) => x.code === 'unknown-ref');
  check('invalid @ref detected', !!d, 'no diagnostic');
  check('suggests "@search"', d?.suggestion === '@search', d?.suggestion);
}

// 3. unknown node type → suggests the close primitive
{
  const d = diagsOf('screen t\nPage { DataTabel @x }').find((x) => x.code === 'unknown-type');
  check('unknown type detected', !!d, 'no diagnostic');
  check('suggests "DataTable"', d?.suggestion === 'DataTable', d?.suggestion);
}

// 4. mutation not declared in `mutates` → suggests the declared target
{
  const src = 'screen t\nstate { users = "" : text }\naction a mutates users <- x {\n  userss.reset()\n}\nPage { Text "x" }';
  const d = diagsOf(src).find((x) => x.code === 'undeclared-mutation');
  check('undeclared mutation detected', !!d, 'no diagnostic');
  check('suggests "users"', d?.suggestion === 'users', d?.suggestion);
}

// 5. syntax error → ParseError with position
{
  let err = null;
  try { parse('screen t\nPage class(  {'); } catch (e) { err = e; }
  check('throws ParseError', err instanceof ParseError, String(err));
  check('ParseError has loc', !!(err?.loc?.line), JSON.stringify(err?.loc));
}

// 6. field typo on an `each` ITEM variable → caught against the list's element entity, suggests the field
{
  const ent = 'entity User { name text  email email }';
  const list = `screen t\n${ent}\nstate { users = [] : list<User> }\n`;
  const bad = diagsOf(`${list}Page { each users as u { Text "{u.naem}" } }`).find((x) => x.code === 'unknown-member');
  check('each item field typo detected', !!bad, 'no diagnostic');
  check('suggests "name"', bad?.suggestion === 'name', bad?.suggestion);
  const ok = diagsOf(`${list}Page { each users as u { Text "{u.name}" } }`);
  check('correct each item field is clean (no false positive)', ok.length === 0, JSON.stringify(ok.map((d) => d.message)));
}

// 7. field typo on an entity-typed STATE, and member access on a scalar (which has no fields at all)
{
  const stTypo = diagsOf('screen t\nentity User { name text }\nstate { user = {} : User }\nPage { Text "{user.naem}" }').find((x) => x.code === 'unknown-member');
  check('entity-state field typo detected', stTypo?.suggestion === 'name', stTypo?.suggestion);
  const scalar = diagsOf('screen t\nstate { count = 0 : number }\nPage { Text "{count.foo}" }').find((x) => x.code === 'unknown-member');
  check('member access on a scalar detected', !!scalar, 'no diagnostic');
}

// 8. type-mismatch (initial value vs declared type), action member typo, and the structured `fix` for auto-apply
{
  const tm = diagsOf('screen t\nstate { count = "" : number }\nPage { Text "x" }').find((x) => x.code === 'type-mismatch');
  check('init/type mismatch detected', !!tm, 'no diagnostic');
  const am = diagsOf('screen t\nstate { x = 0 : number }\naction go mutates x <- v { x.set(v) }\nPage { when go.pendng { Text "x" } }').find((x) => x.code === 'unknown-member');
  check('action member typo → suggests pending', am?.suggestion === 'pending', am?.suggestion);
  const fx = diagsOf('screen t\nstate { search = "" : text }\nPage { SearchField bind @serch "x" }').find((x) => x.code === 'unknown-ref');
  check('diagnostic carries a fix {from,to}', fx?.fix?.from === '@serch' && fx?.fix?.to === '@search', JSON.stringify(fx?.fix));
  check('diagnostic carries `related` (declaration loc)', !!fx?.related?.line, JSON.stringify(fx?.related));
}

// 9. `contains` on a list of ENTITIES (objects) with a scalar → always-false; the oracle catches it (was blind)
{
  const d = diagsOf('screen t\nentity F { symbol text }\nstate { favs = [] : list<F>  sym = "" : text }\nget x = favs contains sym').find((x) => x.code === 'contains-entity');
  check('list<Entity> contains scalar detected', !!d, 'no diagnostic');
  const okScalar = diagsOf('screen t\nstate { favs = [] : list<text>  sym = "" : text }\nget x = favs contains sym');
  check('list<scalar> contains is clean (no false positive)', okScalar.every((x) => x.code !== 'contains-entity'), JSON.stringify(okScalar.map((d) => d.code)));
}

// 10. aggregate/sort OVER a derived `get` resolves the element's fields (was blind: `lt` ignored gets)
{
  const store = 'entity O { amount number  stage text }\nstate { opps = query opps : list<O> }\nmock { opps: [{ amount: 5, stage: "won" }] }\n';
  const clean = diagsOf(store + 'get won = opps.data where stage == "won"\nget wonValue = won.sum by amount', { kind: 'store' });
  check('sum over a get resolves item fields', clean.every((x) => x.code !== 'unknown-ref'), JSON.stringify(clean.map((d) => d.code)));
  const chain = diagsOf(store + 'get a = opps.data where stage == "won"\nget b = a.sortDesc by amount\nget c = b.avg by amount', { kind: 'store' });
  check('chained gets (filter->sort->avg) resolve', chain.every((x) => x.code !== 'unknown-ref'), JSON.stringify(chain.map((d) => d.code)));
  const typo = diagsOf(store + 'get won = opps.data where stage == "won"\nget bad = won.sum by nope', { kind: 'store' }).find((x) => x.code === 'unknown-ref');
  check('still flags a real field typo in the projection', !!typo, 'no diagnostic — over-permissive');
}

// 11. renaming a state must not leave dangling refs: a stale ref in a REACTIVE CLASS cond and a stale
// `mutates` target were both lint-clean before (lint passed → build passed → runtime ReferenceError).
{
  const src = 'screen s\nstate { view = "online" : text }\naction show(t: text) mutates tab { tab.set(t) }\nPage { Button "x" -> show("o") class("on" when tab == "online") }';
  const ds = diagsOf(src);
  check('reactive class cond: stale state ref flagged', ds.some((d) => d.code === 'unknown-ref' && d.message.includes('"tab"')), JSON.stringify(ds.map((d) => d.code)));
  check('action mutates: undeclared state target flagged', ds.some((d) => d.code === 'undeclared-mutation' && d.message.includes('tab')), JSON.stringify(ds.map((d) => d.code)));
  const okClean = diagsOf('screen s\nstate { tab = "online" : text }\naction show(t: text) mutates tab { tab.set(t) }\nPage { Button "x" -> show("o") class("on" when tab == "online") }');
  check('correct state name is clean (no false positive)', okClean.length === 0, JSON.stringify(okClean.map((d) => d.code)));
}

// 12. dynamic sort column: `sort by <text-state>` names the column at runtime (__it[value]) — the user-chosen-
// column case. Was fail-closed (no-op); now supported. A number/bool key (can't name a field) is flagged.
{
  const ent = 'entity D { amount number  stage text }\n';
  const dyn = diagsOf(`screen s\n${ent}state { deals = [] : list<D>  sortCol = "amount" : text }\nget sorted = deals.sortDesc by sortCol\nPage { each sorted as d { Text "{d.stage}" } }`);
  check('dynamic sort by a text state is allowed', dyn.every((d) => d.code !== 'sort-key-type' && d.code !== 'sort-key-not-field'), JSON.stringify(dyn.map((d) => d.code)));
  const badType = diagsOf(`screen s\n${ent}state { deals = [] : list<D>  n = 0 : number }\nget sorted = deals.sortDesc by n\nPage { each sorted as d { Text "{d.stage}" } }`);
  check('dynamic sort by a NUMBER state flagged', badType.some((d) => d.code === 'sort-key-type'), JSON.stringify(badType.map((d) => d.code)));
  const ok = diagsOf(`screen s\n${ent}state { deals = [] : list<D> }\nget sorted = deals.sortDesc by amount\nPage { each sorted as d { Text "{d.stage}" } }`);
  check('sort by a real field is clean (no false positive)', ok.every((d) => d.code !== 'sort-key-type'), JSON.stringify(ok.map((d) => d.code)));
}

// 13. dynamic/interpolated Icon name was lint-clean but build-FAILS (icons inline at build → name must be static).
{
  const bad = diagsOf('screen s\nentity M { icon text }\nstate { items = [] : list<M> }\nPage { each items as m { Icon "{m.icon}" } }');
  check('dynamic Icon name flagged at lint (not build)', bad.some((d) => d.code === 'icon-name'), JSON.stringify(bad.map((d) => d.code)));
  const ok = diagsOf('screen s\nPage { Icon "lucide:settings" }');
  check('static Icon name is clean (no false positive)', ok.every((d) => d.code !== 'icon-name'), JSON.stringify(ok.map((d) => d.code)));
}

// 14. reserved-name: a state/get/action named like a runtime/builtin identifier compiles to a duplicate
// `const` in the same scope → SyntaxError, a blank page that lints green. (youtube `state { query }` crash.)
{
  const q = diagsOf('screen s\nstate { query = "" : text }\nPage { Text "{query}" }').find((x) => x.code === 'reserved-name');
  check('state named `query` flagged (runtime collision)', !!q, 'no diagnostic');
  const money = diagsOf('screen s\nstate { money = 0 : number }\nPage { Text "x" }').find((x) => x.code === 'reserved-name');
  check('state named `money` flagged (builtin collision)', !!money, 'no diagnostic');
  const us = diagsOf('screen s\nstate { __x = 0 : number }\nPage { Text "x" }').find((x) => x.code === 'reserved-name');
  check('state with `__` prefix flagged (runtime-internal)', !!us, 'no diagnostic');
  const ok = diagsOf('screen s\nstate { total = 0 : number }\nPage { Text "x" }');
  check('a normal state name is clean (no false positive)', ok.every((d) => d.code !== 'reserved-name'), JSON.stringify(ok.map((d) => d.code)));
}

// 15. route-param shadow: a `param id` that is also an entity field, used bare in an item-implicit `where`,
// silently resolves to the field (the row's own id), not the URL value — always-wrong, lint-green. (shop bug.)
{
  const ent = 'entity Review { id text  productId text }\n';
  const bad = diagsOf(`screen s\nparam id\n${ent}state { reviews = [] : list<Review> }\nget n = reviews.count where productId == id\nPage { Text "{n}" }`);
  check('route-param shadow in count-where flagged', bad.some((d) => d.code === 'item-shadow' && d.message.includes('route')), JSON.stringify(bad.map((d) => d.code)));
  const ok = diagsOf(`screen s\nparam pid\n${ent}state { reviews = [] : list<Review> }\nget n = reviews.count where productId == pid\nPage { Text "{n}" }`);
  check('a non-colliding route param is clean (no false positive)', ok.every((d) => d.code !== 'item-shadow'), JSON.stringify(ok.map((d) => d.code)));
}

// 16. icon NAME existence (not just shape): a typo'd name passing the `set:name` shape was lint-green but
// crashed the build. With an iconExists checker threaded, the oracle catches it first. (maps `hand-pointer`.)
{
  const stub = (ref) => ref.endsWith(':nope') ? 'no icon named "nope" in set "lucide".' : null;
  const bad = diagsOf('screen s\nPage { Icon "lucide:nope" }', { iconExists: stub }).find((x) => x.code === 'icon-name');
  check('non-existent icon name flagged (via iconExists)', !!bad, 'no diagnostic');
  const ok = diagsOf('screen s\nPage { Icon "lucide:settings" }', { iconExists: stub });
  check('an existing icon name is clean (no false positive)', ok.every((d) => d.code !== 'icon-name'), JSON.stringify(ok.map((d) => d.code)));
  const noChecker = diagsOf('screen s\nPage { Icon "lucide:nope" }'); // not threaded → shape ok → no existence error
  check('no false positive when iconExists is absent', noChecker.every((d) => d.code !== 'icon-name'), JSON.stringify(noChecker.map((d) => d.code)));
}

// 17. self-referential effect = infinite loop: an effect re-runs on every signal it reads, so a TOP-LEVEL
// write of a signal it reads (directly, or via a store action) self-triggers forever — the page hangs silently.
{
  const direct = diagsOf('screen s\nstate { n = 0 : number }\neffect { n.set(n + 1) }\nPage { Text "{n}" }');
  check('direct self-update effect flagged (n.set(n+1))', direct.some((d) => d.code === 'effect-loop'), JSON.stringify(direct.map((d) => d.code)));
  const store = diagsOf('screen s\nstate { x = "" : text }\neffect { ui.visit() }\nPage { Text "{x}" }', { stores: ['ui'], storeMembers: { ui: ['visit'] }, storeSelfMut: new Set(['ui.visit']) });
  check('effect calling a self-updating store action flagged', store.some((d) => d.code === 'effect-loop'), JSON.stringify(store.map((d) => d.code)));
  const safe = diagsOf('screen s\nstate { x = "" : text }\neffect { x.set("hi") }\nPage { Text "{x}" }');
  check('effect setting a constant is clean (no false positive)', safe.every((d) => d.code !== 'effect-loop'), JSON.stringify(safe.map((d) => d.code)));
  const guarded = diagsOf('screen s\nentity I { v text }\nstate { items = [] : list<I> }\neffect { if items.length == 0 { items.push({ v: "x" }) } }\nPage { each items as i { Text "{i.v}" } }');
  check('guarded self-write (converges) is clean (no false positive)', guarded.every((d) => d.code !== 'effect-loop'), JSON.stringify(guarded.map((d) => d.code)));
}

// 18. cross-store aggregate: a PAGE can `count/sum/where` over a STORE's list (the element fields resolve via
// the threaded storeEntities). Was fail-CLOSED ("status is not a known state"); now resolves AND still catches typos.
{
  const ordersEnt = { customer: 'text', amount: 'number', status: 'text' };
  const ctx = { stores: ['orders'], storeMembers: { orders: ['items'] }, storeEntities: { 'orders.items': ordersEnt } };
  const ok = diagsOf('screen s\nstate { f = "paid" : text }\nget n = orders.items.count where status == f\nget rev = orders.items.sum by amount\nPage { Text "{n} {rev}" }', ctx);
  check('cross-store aggregate resolves element fields (no false unknown-ref)', ok.every((d) => d.code !== 'unknown-ref'), JSON.stringify(ok.map((d) => d.code)));
  const typo = diagsOf('screen s\nget n = orders.items.count where staus == "x"\nPage { Text "{n}" }', ctx).find((d) => d.code === 'unknown-ref');
  check('a typo in a cross-store aggregate field is still flagged', !!typo, 'no diagnostic — over-permissive');
}

// 19. `list.take(n)` — first n items for top-N / pagination. Resolves the element (each over it field-checks),
// and the count must be a number.
{
  const ok2 = diagsOf('screen s\nentity P { name text }\nstate { items = [] : list<P>  n = 3 : number }\nget top = items.take(n)\nPage { each items.take(n) as p { Text "{p.name}" } }');
  check('take(n) clean + each over take resolves element fields', ok2.every((d) => d.code !== 'unknown-ref' && d.code !== 'unknown-function'), JSON.stringify(ok2.map((d) => d.code)));
  const typo = diagsOf('screen s\nentity P { name text }\nstate { items = [] : list<P> }\nPage { each items.take(2) as p { Text "{p.naem}" } }').find((d) => d.code === 'unknown-member');
  check('a field typo on an each-over-take item is still caught', !!typo, 'no diagnostic');
  const badN = diagsOf('screen s\nentity P { name text }\nstate { items = [] : list<P>  q = "" : text }\nget top = items.take(q)\nPage { Text "x" }').find((d) => d.code === 'take-count');
  check('take with a non-number count flagged', !!badN, 'no diagnostic');
}

// 20. every STATIC link target must land. A navbar link to an undeclared route, or an in-page `#anchor` with no
// `id()`, used to be lint-green and dead on the page — the whole reason generated landings had no working nav.
{
  const noAnchor = diagsOf('screen s\nPage { Link "Features" -> "#features" }').find((d) => d.code === 'unknown-anchor');
  check('anchor with no id() flagged', !!noAnchor, 'no diagnostic');
  const withAnchor = diagsOf('screen s\nPage { Stack id("features") { Text "f" }  Link "Features" -> "#features" }');
  check('anchor with a matching id() is clean', withAnchor.every((d) => d.code !== 'unknown-anchor'), JSON.stringify(withAnchor.map((d) => d.code)));

  const ctx = { routes: ['/', '/docs', '/product/:pid'] };
  const dangling = diagsOf('screen s\nPage { Link "Nope" -> "/nope" }', ctx).find((d) => d.code === 'unknown-route');
  check('link to an undeclared route flagged', !!dangling, 'no diagnostic');
  const declared = diagsOf('screen s\nPage { Link "Docs" -> "/docs" }', ctx);
  check('link to a declared route is clean', declared.every((d) => d.code !== 'unknown-route'), JSON.stringify(declared.map((d) => d.code)));
  const param = diagsOf('screen s\nPage { Link "P" -> "/product/42" }', ctx);
  check('a literal path satisfies a :param route', param.every((d) => d.code !== 'unknown-route'), JSON.stringify(param.map((d) => d.code)));
  const external = diagsOf('screen s\nPage { Link "X" -> "https://example.com" }', ctx);
  check('an external href is skipped', external.every((d) => d.code !== 'unknown-route'), JSON.stringify(external.map((d) => d.code)));
  const unthreaded = diagsOf('screen s\nPage { Link "Nope" -> "/nope" }'); // routes not threaded -> check skipped
  check('no false positive when routes is absent', unthreaded.every((d) => d.code !== 'unknown-route'), JSON.stringify(unthreaded.map((d) => d.code)));

  const onPage = diagsOf('screen s\nPage id("top") { Text "x" }').find((d) => d.code === 'id-target');
  check('id() on Page flagged (it already owns mu-main)', !!onPage, 'no diagnostic');

  // A link to the page's OWN route is a declared route, so `unknown-route` misses it — yet `go()` bails when the
  // target equals the current path, so it is provably dead. This is the navbar-of-no-ops bug, caught statically.
  const ctxSelf = { routes: ['/landing', '/docs'], selfRoute: '/landing' };
  const selfLink = diagsOf('screen s\nPage { Link "Features" -> "/landing" }', ctxSelf).find((d) => d.code === 'self-link');
  check('link to the page\'s own route flagged', !!selfLink, 'no diagnostic');
  const otherPage = diagsOf('screen s\nPage { Link "Docs" -> "/docs" }', ctxSelf);
  check('link to another route is clean', otherPage.every((d) => d.code !== 'self-link'), JSON.stringify(otherPage.map((d) => d.code)));
  const anchorNotSelf = diagsOf('screen s\nPage { Stack id("f") { Text "x" }  Link "F" -> "#f" }', ctxSelf);
  check('an in-page anchor is not a self-link', anchorNotSelf.every((d) => d.code !== 'self-link'), JSON.stringify(anchorNotSelf.map((d) => d.code)));
  const shell = diagsOf('screen s\nPage { Link "Home" -> "/landing" }', { routes: ['/landing'] }); // shell: no own route
  check('no false positive when selfRoute is absent', shell.every((d) => d.code !== 'self-link'), JSON.stringify(shell.map((d) => d.code)));

  // THE INVARIANT: `ok` means "nothing BLOCKING", not "nothing found". It used to be `D.length === 0`, so the first
  // warning validate ever emitted turned every dev build into a compile error. A warning must never fail a build.
  const warnOnly = validate(toDoc(parse('screen s\nPage { Link "Home" -> "/landing" }')), ctxSelf);
  check('a warning-only page still builds (ok = true)', warnOnly.ok && warnOnly.diagnostics.some((d) => d.code === 'self-link'), JSON.stringify({ ok: warnOnly.ok, codes: warnOnly.diagnostics.map((d) => d.code) }));
  const errPage = validate(toDoc(parse('screen s\nPage { Link "X" -> "/nope" }')), ctxSelf);
  check('an error-severity page does NOT build (ok = false)', !errPage.ok, 'ok was true');
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL OK');
process.exit(fails ? 1 : 0);
