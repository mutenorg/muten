// `.test` files (muten test): what they parse to, and what `muten check` says about one that cannot run.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTests } from '#engine/lang/test-parse.js';
import { checkTests, routeOf } from '#engine/project/check-tests.js';
import { readRoutes } from '#engine/project/routes.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };

{
  const file = parseTests(`# a comment
test "adds" {
  open "/cart"
  press "Add"
  fill "Coupon" with "HALF"
  see "Total: $5"
  see no "Invalid"
  wait 100
}`);
  const steps = file.tests[0].steps;
  ok('one test, six steps', file.tests.length === 1 && steps.length === 6, JSON.stringify(file));
  ok('fill carries its field and value', steps[2].kind === 'fill' && steps[2].target === 'Coupon' && steps[2].value === 'HALF');
  ok('see no is absent', steps[4].kind === 'see' && steps[4].absent === true && steps[3].absent === false);
  ok('a step knows its line', steps[1].loc.line === 4, JSON.stringify(steps[1].loc));
  let message = '';
  try { parseTests('test "x" {\n  pres "Add"\n}'); } catch (e) { message = e.message + ' @' + e.loc?.line; }
  ok('a typo\'d step suggests the word, at its line', message.includes('unknown step "pres"') && message.includes('did you mean `press`') && message.endsWith('@2'), message);
  try { message = ''; parseTests('test "x" {\n  fill "Email" "a@b.co"\n}'); } catch (e) { message = e.message; }
  ok('fill without `with` says so', /expected `with`/.test(message), message);
}

{
  const app = mkdtempSync(join(tmpdir(), 'muten-tests-'));
  mkdirSync(join(app, 'src', 'pages', 'cart'), { recursive: true });
  mkdirSync(join(app, 'src', 'pages', 'item'), { recursive: true });
  mkdirSync(join(app, 'src', 'flows'), { recursive: true });
  writeFileSync(join(app, 'src', 'app.muten'), 'routes {\n  "/cart" -> cart\n  "/item/:id" -> item\n}');
  writeFileSync(join(app, 'src', 'pages', 'cart', 'cart.muten'), 'screen cart\nPage { Text "x" }');
  writeFileSync(join(app, 'src', 'pages', 'item', 'item.muten'), 'screen item\nparam id\nPage { Text "{id}" }');
  writeFileSync(join(app, 'src', 'pages', 'cart', 'cart.test'), 'test "fine" {\n  see "x"\n}');
  writeFileSync(join(app, 'src', 'pages', 'item', 'item.test'), 'test "which item?" {\n  see "7"\n}\ntest "this one" {\n  open "/item/7"\n  see "7"\n}');
  writeFileSync(join(app, 'src', 'flows', 'buy.test'), 'test "goes nowhere" {\n  open "/carts"\n  see "x"\n}\ntest "checks nothing" {\n  open "/cart"\n  press "Add"\n}');
  const routes = readRoutes(app);
  const found = checkTests(app, routes);
  const codes = found.map((d) => `${d.file.split('/').pop()}:${d.code}`).sort();
  ok('a page\'s tests start on its route', routeOf(join(app, 'src', 'pages', 'cart', 'cart.test'), routes) === '/cart');
  ok('a route with params needs an open', codes.includes('item.test:test-no-route') && found.filter((d) => d.code === 'test-no-route').length === 1, codes.join(','));
  ok('open "/item/7" matches "/item/:id"', !found.some((d) => d.code === 'test-unknown-route' && d.message.includes('/item/7')), codes.join(','));
  const unknown = found.find((d) => d.code === 'test-unknown-route');
  ok('an unknown route is an error with the close one', unknown?.severity === 'error' && unknown.suggestion === '/cart', JSON.stringify(unknown));
  ok('a test that checks nothing is a warning', found.some((d) => d.code === 'test-sees-nothing' && d.severity === 'warning'), codes.join(','));
  ok('the clean file says nothing', !codes.some((code) => code.startsWith('cart.test')), codes.join(','));
  rmSync(app, { recursive: true, force: true });
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
