// native-compare: `muten native --compare [route…]`, the phone next to the web, route by route. The web build of the
// same app is the reference (it is what was designed and tested in muten): it is built aside, served, and captured in
// headless Chrome at the emulator's size and density; the same route is opened on the phone. Each pair is saved side
// by side, with how much of the screen matches, so a difference is found by a number and a picture, not by eye.
// No new dependency: Chrome serves as the browser, the canvas and the image diff.
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { bundleEsbuild, loadModel } from './esbuild-muten.js';
import { openOnPhone, screenPng } from './native-android.js';
import { SESSION_FILE } from './native-errors.js';

// the emulator muten sets up: 1080 × 2400 at density 420 → 411 × 914 points
const PHONE = { width: 411, height: 914, scale: 2.625 };
const SETTLE_MS = 2600;   // a route opened: its data loaded and its entry animation over
const TYPES: { readonly [ext: string]: string } = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const SAMPLE_PARAM = '1';

interface Pair { route: string; file: string; match: number }
/** What Chrome answers (DevTools protocol): only the fields muten reads. */
interface CdpAnswer { result?: { data?: string; targetId?: string; sessionId?: string; result?: { value?: { match: number; png: string } } } }
type Send = (method: string, params?: object) => Promise<CdpAnswer>;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser to capture with: CHROME, a system Chrome/Chromium, or the one Playwright downloaded. */
function findChrome(): string | null {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) if (spawnSync('which', [name]).status === 0) return name;
  const playwright = join(homedir(), '.cache', 'ms-playwright');
  const found = existsSync(playwright) ? spawnSync('find', [playwright, '-name', 'chrome', '-type', 'f'], { encoding: 'utf8' }).stdout.split('\n')[0] : '';
  return found || null;
}

/** The web build, served: the app's own routes answer with index.html. */
function serve(dir: string): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let file = join(dir, decodeURIComponent((req.url || '/').split('?')[0]));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, () => { const address = server.address(); resolve({ server, port: typeof address === 'object' && address ? address.port : 0 }); }));
}

/** A page in headless Chrome, at the phone's size, and the way to talk to it (DevTools protocol). */
async function browser(chrome: string, profile: string): Promise<{ send: Send; close: () => Promise<void> }> {
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const address = await new Promise<string>((resolve, reject) => {
    child.stderr?.on('data', (chunk: Buffer) => { const found = /ws:\/\/\S+/.exec(chunk.toString()); if (found) resolve(found[0]); });
    child.on('exit', () => reject(new Error('Chrome did not start')));
  });
  const socket = new WebSocket(address);
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let next = 0;
  const waiting = new Map<number, (message: CdpAnswer) => void>();
  socket.addEventListener('message', (event) => { const message: CdpAnswer & { id?: number } = JSON.parse(String(event.data)); if (message.id && waiting.has(message.id)) { waiting.get(message.id)?.(message); waiting.delete(message.id); } });
  let session: string | undefined;
  const raw = (method: string, params: object = {}): Promise<CdpAnswer> => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); socket.send(JSON.stringify({ id, method, params, sessionId: session })); });
  const target = await raw('Target.createTarget', { url: 'about:blank' });
  const attached = await raw('Target.attachToTarget', { targetId: target.result?.targetId, flatten: true });
  session = String(attached.result?.sessionId);
  await raw('Page.enable');
  await raw('Emulation.setDeviceMetricsOverride', { width: PHONE.width, height: PHONE.height, deviceScaleFactor: PHONE.scale, mobile: true });
  // closed: Chrome is gone (it writes to its profile until it exits) before the profile is removed
  return { send: raw, close: () => new Promise<void>((resolve) => { child.once('exit', () => resolve()); socket.close(); child.kill(); }) };
}

// runs in the page: the two shots side by side, and the share of the screen that matches. The phone has a status bar
// the web does not: the phone's shot is slid up to where it lines up best before counting
const COMPARE = `async (web, phone, label) => {
  const load = (src) => new Promise((done) => { const image = new Image(); image.onload = () => done(image); image.src = src; });
  const [a, b] = await Promise.all([load(web), load(phone)]);
  const W = 270, H = 600, grey = (image, dy) => { const c = new OffscreenCanvas(W, H), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(image, 0, -dy * H / image.height, W, H); const d = g.getImageData(0, 0, W, H).data; const out = new Float32Array(W * H); for (let i = 0; i < out.length; i++) out[i] = d[i * 4] * .3 + d[i * 4 + 1] * .59 + d[i * 4 + 2] * .11; return out; };
  const ref = grey(a, 0);
  let best = { match: 0, dy: 0 };
  for (let dy = 0; dy <= 160; dy += 8) {
    const other = grey(b, dy); let same = 0, total = 0;
    for (let y = 0; y < H - 40; y++) for (let x = 0; x < W; x++) { total++; if (Math.abs(ref[y * W + x] - other[y * W + x]) < 28) same++; }
    if (same / total > best.match) best = { match: same / total, dy };
  }
  const sheet = new OffscreenCanvas(a.width + b.width + 24, Math.max(a.height, b.height) + 64), g = sheet.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = '600 30px sans-serif'; g.fillStyle = '#111';
  g.fillText(label + ' · web', 12, 42); g.fillText('teléfono · ' + Math.round(best.match * 100) + ' % igual', a.width + 36, 42);
  g.drawImage(a, 0, 64); g.drawImage(b, a.width + 24, 64);
  const blob = await sheet.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { match: best.match, png: btoa(text) };
}`;

/** The address Metro gave the app (`exp://192.168.…:8081`), from the open session's log. */
function sessionAddress(dir: string): string | null {
  const log = join(dir, SESSION_FILE);
  if (!existsSync(log)) return null;
  const found = /(exp:\/\/[\d.]+:\d+)/.exec(readFileSync(log, 'utf8'));
  return found ? found[1] : null;
}

/** `muten native --compare`: each route on the web and on the phone, side by side, with how much matches. */
export async function nativeCompare(root: string, dir: string, args: string[]): Promise<boolean> {
  const address = sessionAddress(dir);
  if (!address || !screenPng()) { console.error('✖ no session is open: muten native --android opens one, then --compare'); return false; }
  const chrome = findChrome();
  if (!chrome) { console.error('✖ no Chrome or Chromium found: install one, or point CHROME at it'); return false; }
  const model = await loadModel(root);
  const asked = args.filter((arg) => arg.startsWith('/'));
  const routes = asked.length ? asked : (model.appIr?.routes || []).map((route) => route.url.replace(/:[\w]+/g, SAMPLE_PARAM)).filter((url) => !/404/.test(url));
  const storageArg = args.find((arg) => arg.startsWith('--storage='));
  const storage: { [key: string]: string | number | boolean } = storageArg ? JSON.parse(storageArg.slice(10)) : {};

  const out = join(dir, 'compare');
  const web = join(out, 'web');
  mkdirSync(out, { recursive: true });
  console.log('  · building the web version (the reference)…');
  await bundleEsbuild(root, web);
  const { server, port } = await serve(web);
  const profile = mkdtempSync(join(tmpdir(), 'muten-compare-'));
  const page = await browser(chrome, profile);
  const pairs: Pair[] = [];
  try {
    await page.send('Page.navigate', { url: `http://localhost:${port}/` });
    await wait(1200);
    // the web starts from the same saved state the phone is in (a session, a setting): what --storage gives
    await page.send('Runtime.evaluate', { expression: `(() => { const s = ${JSON.stringify(storage)}; for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); })()` });
    for (const route of routes) {
      openOnPhone(`${address}/--${route}`);
      await page.send('Page.navigate', { url: `http://localhost:${port}${route}` });
      await wait(SETTLE_MS);
      const webShot = await page.send('Page.captureScreenshot', { format: 'png' });
      const phone = screenPng();
      if (!phone || !webShot.result?.data) { console.error(`  ✖ ${route}: no capture`); continue; }
      const name = route === '/' ? 'home' : route.slice(1).replace(/\//g, '-');
      const compared = await page.send('Runtime.evaluate', { expression: `(${COMPARE})(${JSON.stringify(`data:image/png;base64,${webShot.result.data}`)}, ${JSON.stringify(`data:image/png;base64,${phone.toString('base64')}`)}, ${JSON.stringify(route)})`, awaitPromise: true, returnByValue: true });
      const value = compared.result?.result?.value;
      if (!value) { console.error(`  ✖ ${route}: the comparison failed`); continue; }
      const file = join(out, `${name}.png`);
      writeFileSync(file, Buffer.from(value.png, 'base64'));
      pairs.push({ route, file, match: value.match });
      console.log(`  ${value.match >= 0.95 ? '✓' : value.match >= 0.85 ? '~' : '✖'} ${route.padEnd(16)} ${String(Math.round(value.match * 100)).padStart(3)} % igual   ${relative(process.cwd(), file)}`);
    }
  } finally {
    await page.close(); server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const average = pairs.length ? pairs.reduce((sum, pair) => sum + pair.match, 0) / pairs.length : 0;
  console.log(`\n  ${pairs.length} route(s), ${Math.round(average * 100)} % igual de media (✓ 95 % o más · ~ 85 % o más · ✖ menos)\n`);
  return pairs.length > 0;
}
