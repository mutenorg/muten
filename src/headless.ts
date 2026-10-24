// headless: a Chrome of muten's own, driven over the DevTools protocol, and a local server for a built app. Used by
// `muten test` (the app's .test files) and by `muten bundle`'s prerender (each page drawn once, written out as HTML).
// The browser is whatever Chrome or Chromium the machine has (CHROME_PATH points at another); both callers refuse
// every request that leaves the local server, so nothing they run reaches a real API.
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { extname, join, sep } from 'node:path';

const CHROMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'];
const MIME: { readonly [ext: string]: string } = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
export const LOAD_TIMEOUT_MS = 10000;

export interface CdpMessage { id?: number; method?: string; sessionId?: string; result?: CdpResult; error?: { message: string }; params?: CdpParams }
export interface CdpResult { [key: string]: CdpValue }
export interface CdpParams { [key: string]: CdpValue }
export type CdpValue = string | number | boolean | null | undefined | CdpValue[] | { [key: string]: CdpValue };

/** The Chrome or Chromium to drive: CHROME_PATH, else the first known one on this machine. */
export function findChrome(): string | null {
  const own = process.env.CHROME_PATH;
  if (own) return own;
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  for (const name of CHROMES) {
    if (name.includes(sep) || name.includes('/')) { if (existsSync(name)) return name; continue; }
    for (const dir of dirs) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export class Cdp {
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

/** Starts a headless browser with its own profile folder. */
export async function launch(chrome: string, profile: string, lang = ''): Promise<{ process: ChildProcess; cdp: Cdp }> {
  // `lang`: the browser's language (navigator.language), so what an app picks from it does not depend on this machine
  const language = lang ? [`--lang=${lang}`, `--accept-lang=${lang}`] : [];
  const child = spawn(chrome, ['--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...language, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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

/** Serves a built app from `dir`; every path that is no file gets `fallback` (the router takes it), index.html by default. */
export function serve(dir: string, fallback?: () => string): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url || '/').split('?')[0]);
    const file = join(dir, path);
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory() || (fallback && extname(file) === '.html')) {
      response.writeHead(200, { 'content-type': MIME['.html'] });
      if (fallback) { response.end(fallback()); return; }
      createReadStream(join(dir, 'index.html')).pipe(response);
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    done({ server, base: `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}` });
  }));
}

// what a page asks for as data (its API): with `hold`, never answered, so the page stays as it is while data is on the way
const DATA_REQUESTS = new Set(['Fetch', 'XHR', 'EventSource', 'WebSocket']);

/** A page of its own (its own context: no storage, cookies or cache from another) where only `allowed` URLs load. Any
 *  other request fails; with `hold`, a request for DATA is never answered instead (the page shows its loading state).
 *  A stylesheet, font or script from elsewhere still fails at once: held, a stylesheet in <head> stopped the page. */
export async function openPage(cdp: Cdp, allowed: (url: string) => boolean, hold = false): Promise<{ session: string; close: () => Promise<void> }> {
  const context = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  const browserContextId = String(context.result?.browserContextId ?? '');
  const target = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const attached = await cdp.send('Target.attachToTarget', { targetId: String(target.result?.targetId ?? ''), flatten: true });
  const session = String(attached.result?.sessionId ?? '');
  const stop = cdp.on((message) => {
    if (message.sessionId !== session) return;
    // a page that asks before it is left («leave without saving?») would stop every navigation after it: answered yes
    if (message.method === 'Page.javascriptDialogOpening') { void cdp.send('Page.handleJavaScriptDialog', { accept: true }, session); return; }
    if (message.method !== 'Fetch.requestPaused') return;
    const requestId = String(message.params?.requestId ?? '');
    const request = message.params?.request;
    const url = request && typeof request === 'object' && !Array.isArray(request) ? String(request.url ?? '') : '';
    const kind = String(message.params?.resourceType ?? '');
    if (allowed(url)) void cdp.send('Fetch.continueRequest', { requestId }, session);
    else if (!hold || !DATA_REQUESTS.has(kind)) void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, session);
  });
  await cdp.send('Runtime.enable', {}, session);
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
  return { session, close: async () => { stop(); await cdp.send('Target.disposeBrowserContext', { browserContextId }); } };
}

/** Closes the browser and waits for it to be gone (its profile folder can be removed then). */
export async function shutDown(browser: ChildProcess): Promise<void> {
  const closed = new Promise((done) => browser.once('exit', done));
  browser.kill();
  await closed;
}
