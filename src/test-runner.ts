// test-runner: `muten test`. Runs every `.test` file of the app in a real headless browser:
//   · the app is bundled with its `mock` data and no `sources` (a test never reaches a real API), and every request
//     that leaves the test server is refused, so not even a hand-written fetch gets out;
//   · each test opens in a browser context of its own (no localStorage, cookies or cache from the one before);
//   · a step that does not hold, or an error the page throws, fails the test at its line.
// A page's tests live next to it (`src/pages/cart/cart.test`) and start on its route; `open "/x"` goes elsewhere.
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { bundleEsbuild } from './esbuild-muten.js';
import { DRIVER_JS } from './test-driver.js';
import { checkTests, findTests } from '#engine/project/check-tests.js';
import { readRoutes } from '#engine/project/routes.js';
import { formatDiagnostic } from '#engine/shared/diagnostics.js';
import { TestKw, TEST_EXT } from '#engine/shared/vocab.js';
import type { Loc, TestCase, TestStep } from '#engine/shared/types.js';

const CHROMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
const MIME: { readonly [ext: string]: string } = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const LOAD_TIMEOUT_MS = 10000;

interface CdpMessage { id?: number; method?: string; sessionId?: string; result?: CdpResult; error?: { message: string }; params?: CdpParams }
interface CdpResult { [key: string]: CdpValue }
interface CdpParams { [key: string]: CdpValue }
type CdpValue = string | number | boolean | null | undefined | CdpValue[] | { [key: string]: CdpValue };
interface Outcome { passed: number; failed: number }

// ── the browser ──

function findChrome(): string | null {
  const own = process.env.CHROME_PATH;
  if (own) return own;
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const name of CHROMES) {
    if (name.includes(sep) || name.includes('/')) { if (existsSync(name)) return name; continue; }
    for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

class Cdp {
  private nextId = 0;
  private readonly waiting = new Map<number, (message: CdpMessage) => void>();
  private readonly listeners: Array<(message: CdpMessage) => void> = [];
  private readonly socket: WebSocket;
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message: CdpMessage = JSON.parse(String(event.data));
      if (message.id !== undefined) { this.waiting.get(message.id)?.(message); this.waiting.delete(message.id); }
      else for (const listen of this.listeners) listen(message);
    });
  }
  send(method: string, params: CdpParams = {}, sessionId?: string): Promise<CdpMessage> {
    const id = ++this.nextId;
    return new Promise((done) => { this.waiting.set(id, done); this.socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  on(listen: (message: CdpMessage) => void): () => void {
    this.listeners.push(listen);
    return () => { const at = this.listeners.indexOf(listen); if (at >= 0) this.listeners.splice(at, 1); };
  }
}

async function launch(chrome: string, profile: string): Promise<{ process: ChildProcess; cdp: Cdp }> {
  const child = spawn(chrome, ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const url = await new Promise<string>((done, fail) => {
    let said = '';
    const timer = setTimeout(() => fail(new Error('the browser did not start')), LOAD_TIMEOUT_MS);
    child.stderr?.on('data', (chunk) => { said += chunk; const match = /DevTools listening on (ws:\/\/\S+)/.exec(said); if (match) { clearTimeout(timer); done(match[1]); } });
    child.on('exit', () => fail(new Error('the browser closed while starting: ' + said.slice(0, 300))));
  });
  const socket = new WebSocket(url);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  return { process: child, cdp: new Cdp(socket) };
}

// ── the app ──

function serve(dir: string): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url || '/').split('?')[0]);
    let file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');   // the app's router takes every other path
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    done({ server, base: `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}` });
  }));
}

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
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const browserContextId = String(context.result?.browserContextId ?? '');
  const target = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const attached = await cdp.send('Target.attachToTarget', { targetId: String(target.result?.targetId ?? ''), flatten: true });
  const session = String(attached.result?.sessionId ?? '');
  const thrown: string[] = [];
  const stop = cdp.on((message) => {
    if (message.sessionId !== session) return;
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params?.exceptionDetails;
      const text = details && typeof details === 'object' && !Array.isArray(details) ? details.exception : null;
      thrown.push(text && typeof text === 'object' && !Array.isArray(text) ? String(text.description ?? '').split('\n')[0] : 'an error');
    }
    if (message.method === 'Fetch.requestPaused') {   // only the test server answers; anything else is refused
      const requestId = String(message.params?.requestId ?? '');
      const request = message.params?.request;
      const url = request && typeof request === 'object' && !Array.isArray(request) ? String(request.url ?? '') : '';
      if (url.startsWith(base)) void cdp.send('Fetch.continueRequest', { requestId }, session);
      else void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, session);
    }
  });
  const go = async (route: string): Promise<string | null> => {
    await cdp.send('Page.navigate', { url: base + route }, session);
    const ready = await cdp.send('Runtime.evaluate', { expression: `new Promise((done) => { const end = Date.now() + ${LOAD_TIMEOUT_MS}; (function wait() { if (document.readyState === 'complete' || Date.now() > end) done(document.readyState); else setTimeout(wait, 20); })(); })`, awaitPromise: true, returnByValue: true }, session);
    await cdp.send('Runtime.evaluate', { expression: DRIVER_JS }, session);
    const state = ready.result?.result;
    return state && typeof state === 'object' && !Array.isArray(state) && state.value === 'complete' ? null : `${route} did not finish loading`;
  };
  try {
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
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
    await cdp.send('Target.disposeBrowserContext', { browserContextId });
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
    const closed = new Promise((done) => browser.process.once('exit', done));
    browser.process.kill();
    await closed;
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${outcome.failed ? '✖' : '✓'} ${outcome.passed} passed${outcome.failed ? `, ${outcome.failed} failed` : ''}`);
  return outcome.failed === 0;
}
