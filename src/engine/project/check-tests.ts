// check-tests: the app's `.test` files, found and checked like the rest of the app (`muten check`), and the facts
// `muten test` runs them with. A test that cannot run is an error before any browser starts: a step that does not
// parse, an `open` to a route the app does not have, a test in a file that is not next to a page and opens nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseTests } from '#engine/lang/test-parse.js';
import { ParseError, diag, closest } from '#engine/shared/diagnostics.js';
import { TestKw, TEST_EXT } from '#engine/shared/vocab.js';
import type { Diagnostic, RouteEntry, TestFile } from '#engine/shared/types.js';

/** A test file with what it starts on (its page's route, or null when it is not next to a routed page). */
export interface FoundTests { file: string; route: string | null; tests: TestFile }

/** Every `.test` file under `dir` (node_modules aside). */
export function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    return entry.name.endsWith(TEST_EXT) ? [full] : [];
  });
}

/** The route a page's own tests start on: the route of the page in the folder they sit in. */
export function routeOf(file: string, routes: RouteEntry[]): string | null {
  const page = basename(file, TEST_EXT);
  const entry = routes.find((route) => route.page === page && dirname(route.screenPath) === dirname(file));
  return entry && !entry.route.includes(':') ? '/' + entry.route : null;   // a route with params needs the test to say which
}

// does a concrete path ("/product/7") match a declared route ("/product/:id")?
function routeMatches(path: string, declared: string): boolean {
  const want = path.split('?')[0].split('/').filter(Boolean);
  const have = declared.split('/').filter(Boolean);
  return want.length === have.length && have.every((segment, index) => segment.startsWith(':') || segment === want[index]);
}

/** The diagnostics of one `.test` file, from its text (the editor checks it as it is typed). */
export function checkTestFile(file: string, source: string, routes: RouteEntry[]): Diagnostic[] {
  const declared = routes.map((route) => '/' + route.route);
  let tests: TestFile;
  try { tests = parseTests(source); }
  catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return [{ code: e.code, severity: 'error', message: e.message, loc: e.loc, suggestion: null }];
  }
  const out: Diagnostic[] = [];
  const start = routeOf(file, routes);
  for (const test of tests.tests) {
    if (!test.steps.length) { out.push(diag('test-empty', `test "${test.name}" has no steps`, { loc: test.loc, severity: 'warning' })); continue; }
    if (!start && test.steps[0].kind !== TestKw.Open) out.push(diag('test-no-route', `test "${test.name}" does not say where it starts: this file is not next to a page with a fixed route, so begin with \`open "/route"\``, { loc: test.loc }));
    if (!test.steps.some((step) => step.kind === TestKw.See)) out.push(diag('test-sees-nothing', `test "${test.name}" never checks anything: add a \`see "…"\` (or \`see no "…"\`) for what must be true after its steps`, { loc: test.loc, severity: 'warning' }));
    for (const step of test.steps) {
      if (step.kind !== TestKw.Open || declared.some((route) => routeMatches(step.route, route))) continue;
      out.push(diag('test-unknown-route', `open "${step.route}": the app has no such route`, { loc: step.loc, suggestion: closest(step.route, declared) }));
    }
  }
  return out;
}

/** The diagnostics of every `.test` file of the app, each with its file. */
export function checkTests(appRoot: string, routes: RouteEntry[]): Array<{ file: string } & Diagnostic> {
  return testFiles(join(appRoot, 'src')).flatMap((file) => checkTestFile(file, readFileSync(file, 'utf8'), routes).map((found) => ({ file: relative(appRoot, file), ...found })));
}

/** The tests to run, parsed (a file that does not parse is left to `checkTests` to report). */
export function findTests(appRoot: string, routes: RouteEntry[]): FoundTests[] {
  return testFiles(join(appRoot, 'src')).flatMap((file) => {
    try { return [{ file, route: routeOf(file, routes), tests: parseTests(readFileSync(file, 'utf8')) }]; }
    catch (e) { if (e instanceof ParseError) return []; throw e; }
  });
}
