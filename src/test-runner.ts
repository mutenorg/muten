// test-runner: `muten test`. Runs every `.test` file of the app in a real headless browser:
//   · the app is bundled with its `mock` data and no `sources` (a test never reaches a real API), and every request
//     that leaves the test server is refused, so not even a hand-written fetch gets out;
//   · each test opens in a browser context of its own (no localStorage, cookies or cache from the one before);
//   · a step that does not hold, or an error the page throws, fails the test at its line.
// A page's tests live next to it (`src/pages/cart/cart.test`) and start on its route; `open "/x"` goes elsewhere.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findChrome, launch, serve, openPage, shutDown, LOAD_TIMEOUT_MS, type Cdp } from './headless.js';
import { bundleEsbuild } from './esbuild-muten.js';
import { DRIVER_JS } from './test-driver.js';
import { checkTests, findTests } from '#engine/project/check-tests.js';
import { readRoutes } from '#engine/project/routes.js';
import { formatDiagnostic } from '#engine/shared/diagnostics.js';
import { TestKw, TEST_EXT } from '#engine/shared/vocab.js';
import type { Loc, TestCase, TestStep } from '#engine/shared/types.js';

interface Outcome { passed: number; failed: number }

// ── one test ──

const describe = (step: TestStep): string => {
  switch (step.kind) {
    case TestKw.Open: return `open "${step.route}"`;
    case TestKw.Press: return `press "${step.target}"`;
    case TestKw.Fill: return `fill "${step.target}" with "${step.value}"`;
    case TestKw.See: return `see ${step.absent ? 'no ' : ''}"${step.text}"`;
    case TestKw.Wait: return `wait ${step.ms}`;
  }
};

const callDriver = (step: TestStep): string => {
  switch (step.kind) {
    case TestKw.Press: return `window.__mutenTest.press(${JSON.stringify(step.target)})`;
    case TestKw.Fill: return `window.__mutenTest.fill(${JSON.stringify(step.target)}, ${JSON.stringify(step.value)})`;
    case TestKw.See: return `window.__mutenTest.see(${JSON.stringify(step.text)}, ${step.absent})`;
    case TestKw.Open: case TestKw.Wait: return 'null';
  }
};

async function runTest(cdp: Cdp, base: string, start: string | null, test: TestCase): Promise<{ failure: string | null; at: Loc }> {
  const { session, close } = await openPage(cdp, (url) => url.startsWith(base));   // only the test server answers
  const thrown: string[] = [];
  const stop = cdp.on((message) => {
    if (message.sessionId !== session || message.method !== 'Runtime.exceptionThrown') return;
    const details = message.params?.exceptionDetails;
    const text = details && typeof details === 'object' && !Array.isArray(details) ? details.exception : null;
    thrown.push(text && typeof text === 'object' && !Array.isArray(text) ? String(text.description ?? '').split('\n')[0] : 'an error');
  });
  const go = async (route: string): Promise<string | null> => {
    await cdp.send('Page.navigate', { url: base + route }, session);
    const ready = await cdp.send('Runtime.evaluate', { expression: `new Promise((done) => { const end = Date.now() + ${LOAD_TIMEOUT_MS}; (function wait() { if (document.readyState === 'complete' || Date.now() > end) done(document.readyState); else setTimeout(wait, 20); })(); })`, awaitPromise: true, returnByValue: true }, session);
    await cdp.send('Runtime.evaluate', { expression: DRIVER_JS }, session);
    const state = ready.result?.result;
    return state && typeof state === 'object' && !Array.isArray(state) && state.value === 'complete' ? null : `${route} did not finish loading`;
  };
  try {
    const first = test.steps[0];
    const opens = first?.kind === TestKw.Open;
    if (!opens && !start) return { failure: 'this file is not next to a page with a route: start the test with `open "/route"`', at: test.loc };
    if (!opens && start) { const failed = await go(start); if (failed) return { failure: failed, at: test.loc }; }
    for (const step of test.steps) {
      let failure: string | null = null;
      if (step.kind === TestKw.Open) failure = await go(step.route);
      else if (step.kind === TestKw.Wait) await new Promise((done) => setTimeout(done, step.ms));
      else {
        const answer = await cdp.send('Runtime.evaluate', { expression: callDriver(step), awaitPromise: true, returnByValue: true }, session);
        const value = answer.result?.result;
        const said = value && typeof value === 'object' && !Array.isArray(value) ? value.value : null;
        failure = typeof said === 'string' ? said : answer.error ? answer.error.message : null;
      }
      if (!failure && thrown.length) failure = `the page threw: ${thrown[0]}`;
      if (failure) return { failure: `${describe(step)}: ${failure}`, at: step.loc };
    }
    return { failure: null, at: test.loc };
  } finally {
    stop();
    await close();
  }
}

// ── the command ──

/** Runs the app's `.test` files (only the tests whose name contains `only`, when given). True when all passed. */
export async function testApp(root: string, only = ''): Promise<boolean> {
  if (typeof WebSocket === 'undefined') { console.error('✖ muten test needs Node 22 or newer (it talks to the browser over a WebSocket)'); return false; }
  const routes = readRoutes(root);
  // what `muten check` would say about the tests comes first: a test that cannot run fails before the browser starts
  const problems = checkTests(root, routes);
  for (const problem of problems) console.error(formatDiagnostic(problem, problem.file, readFileSync(join(root, problem.file), 'utf8')));
  const broken = problems.filter((problem) => problem.severity === 'error').length;
  if (broken) { console.log(`\n✖ ${broken} test problem(s): fix them first (muten check shows them too)`); return false; }
  const found = findTests(root, routes);
  const total = found.reduce((sum, item) => sum + item.tests.tests.filter((test) => test.name.includes(only)).length, 0);
  if (!total) { console.log(`no tests: write one next to a page, e.g. src/pages/home/home${TEST_EXT}:\n  test "the home says hello" {\n    see "Hello"\n  }`); return true; }
  const chrome = findChrome();
  if (!chrome) { console.error('✖ muten test runs in Chrome or Chromium, and neither was found. Install one, or point CHROME_PATH at it.'); return false; }

  const work = mkdtempSync(join(tmpdir(), 'muten-test-'));
  const { outDir } = await bundleEsbuild(root, join(work, 'dist'), { mocksOnly: true, quiet: true });
  const { server, base } = await serve(outDir);
  const browser = await launch(chrome, join(work, 'profile'));
  const outcome: Outcome = { passed: 0, failed: 0 };
  try {
    for (const { file, route, tests } of found) {
      const chosen = tests.tests.filter((test) => test.name.includes(only));
      if (!chosen.length) continue;
      console.log(`\n${relative(root, file)}`);
      for (const test of chosen) {
        const { failure, at } = await runTest(browser.cdp, base, route, test);
        if (failure) { outcome.failed++; console.log(`  ✗ ${test.name}\n      ${relative(root, file)}:${at.line}:${at.col}  ${failure}`); }
        else { outcome.passed++; console.log(`  ✓ ${test.name}`); }
      }
    }
  } finally {
    await shutDown(browser.process);
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${outcome.failed ? '✖' : '✓'} ${outcome.passed} passed${outcome.failed ? `, ${outcome.failed} failed` : ''}`);
  return outcome.failed === 0;
}
