// dev-server: `muten dev`. An incremental esbuild build kept fully IN MEMORY (nothing written to the project) + the
// CSS rebuilt each pass + a small static server with SPA fallback + SSE reload, with surgical HMR when only a node's
// props changed (diffDoc). This machine only unless `--host` (a phone on the same wifi, with a QR to scan).
// The build itself (model, plugin, CSS) lives in esbuild-muten.ts and is shared with `muten bundle`.
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, existsSync, readdirSync, realpathSync, watch, mkdirSync } from 'node:fs';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';
import { loadModel, mutenEsbuild, buildCss, buildFailureErrors, readIndexHtml } from './esbuild-muten.js';
import { load, loadAllParts } from '#engine/project/load.js';
import { compileNodePatch } from '#engine/compile/compile.js';
import { devToken, fileInside, hostAllowed, openInEditor, appFile } from './dev-security.js';
import { envDefines } from '#engine/project/env.js';
import { mapApp } from '#engine/project/map.js';
import type { Doc } from '#engine/shared/types.js';
import { ParseError, diag, formatDiagnostic } from '#engine/shared/diagnostics.js';
import { libraryOptions } from '#engine/project/bundle-options.js';
import { waitForFix } from './dev-wait.js';
import { placeRuntimeError } from './dev-errors.js';
import { LAST_ERROR } from './report.js';
import { devKeys } from './dev-keys.js';
import { devtoolsAnswer, forgetIssues } from './devtools-server.js';

const ERROR_BODY_MAX = 64 * 1024;   // a stack, not an upload

const here = dirname(fileURLToPath(import.meta.url));
// A QR encoder is Reed-Solomon, not a few lines — so this is the one place a dependency beats owning the code.
// It stays in the CLI: nothing here ever reaches an app's bundle. Typed structurally (the package is CJS) so the
// surface we use is honest without pulling @types.
type QrFactory = (typeNumber: number, errorLevel: string) => {
  addData(data: string): void;
  make(): void;
  createSvgTag(options: { cellSize: number; margin: number }): string;
};

const qrcode: QrFactory = createRequire(import.meta.url)('qrcode-generator');


// dev-only: `url` as a scannable code. Scanning opens the REAL app over the LAN, HMR and all — the dev server binds
// every interface and /_reload is a relative path, so the phone needs no setup. What makes it run as an app rather
// than a tab (fullscreen, safe areas, an icon) is public/manifest.webmanifest + Chrome's Install.
const QR_BODY = 'margin:0;height:100vh;display:grid;place-content:center;justify-items:center;gap:20px'
  + ';background:#1a1a1f;color:#f5f5f5;font:14px/1.6 ui-monospace,monospace;text-align:center';


const MIME: { [ext: string]: string } = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

 // esbuild namespace for the virtual modules

// The dev server binds LOCALHOST unless asked (`muten dev --host`, or `dev { host "lan" }` in muten.config): a server
// bound to every interface hands the project to anyone on the same wifi (see devSecurity.ts). With --host, these are
// the addresses to hand a phone. HMR follows for free: the client opens EventSource('/_reload'),
// a same-origin relative path, so it works from whatever host the page was served from.
// Only a top-level page opens it: the stream never closes, Chrome allows six connections per host, and a page
// showing several dev pages in iframes (a row of store previews) would leave the seventh waiting forever.
// The pages the server writes itself (the error, the QR, the SPA shell) say their encoding: without it a browser reads
// the UTF-8 bytes as Latin-1 and «muten — compile error» comes out as «muten â€” compile error».
const HTML_UTF8 = 'text/html; charset=utf-8';

// A failure that is not esbuild's (a syntax error in a part, read while loading the app): where it is and the line
// pointed at, as `muten check` prints it, instead of the bare message with no file.
function describeFailure(error: unknown, root: string): string {
  if (!(error instanceof ParseError)) return error instanceof Error ? error.message : String(error);
  const file = error.file ? relative(root, error.file) : '';
  if (!file || !error.loc) return file ? `${file}  ${error.message}` : error.message;
  let source = '';
  try { source = readFileSync(error.file || '', 'utf8'); } catch { /* the file went away: no frame */ }
  return formatDiagnostic(diag(error.code, error.message, { loc: error.loc }), file, source);
}

const lanAddresses = (): string[] => Object.values(networkInterfaces())
  .flatMap((ifaces) => ifaces ?? [])
  .filter((iface) => iface.family === 'IPv4' && !iface.internal)
  .map((iface) => iface.address);

function qrPage(lan: string | undefined, port: number): string {
  if (!lan) return `<!doctype html><title>muten — open on your phone</title><body style="${QR_BODY}">`
    + '<p>No LAN address found.</p><p style="opacity:.6">Connect this machine to wifi and reload.</p></body>';
  const url = `http://${lan}:${port}/`;
  const code = qrcode(0, 'M');
  code.addData(url);
  code.make();
  // `margin` is in PIXELS, not modules: the QR spec wants a 4-module quiet zone, so it has to track cellSize.
  const cellSize = 6;
  return `<!doctype html><title>muten — open on your phone</title><body style="${QR_BODY}">`
    + `<div style="background:#fff;padding:16px;border-radius:12px;line-height:0">${code.createSvgTag({ cellSize, margin: cellSize * 4 })}</div>`
    + `<div><div style="color:#FF5E00;font-weight:600;font-size:16px">${url}</div>`
    + '<div style="opacity:.6;margin-top:12px">Scan it — the app runs on your phone with live reload.<br>'
    + 'To run it as a real app: Chrome ▸ ⋮ ▸ Install app</div></div></body>';
}


// HMR diff: compare the previously-mounted page Doc with the freshly-compiled one, by node id. A change confined
// to a node's own props/text (same type, same children) → patch just that node. Anything touching the signal graph
// or tree shape (declarations, node set, types, children) → full reload. Conservative on purpose.
function diffDoc(a: Doc, b: Doc): { reload: boolean; patches: string[] } {
  const decls = (d: Doc): string => JSON.stringify([d.state, d.actions, d.gets, d.params, d.entities, d.consts, d.effects, d.meta]);
  if (decls(a) !== decls(b)) return { reload: true, patches: [] };
  const ka = Object.keys(a.nodes), kb = Object.keys(b.nodes);
  if (ka.length !== kb.length || kb.some((id) => !a.nodes[id])) return { reload: true, patches: [] };
  const patches: string[] = [];
  for (const id of kb) {
    const na = a.nodes[id], nb = b.nodes[id];
    if (na.type !== nb.type || JSON.stringify(na.children) !== JSON.stringify(nb.children)) return { reload: true, patches: [] };
    if (JSON.stringify(na.props) !== JSON.stringify(nb.props)) patches.push(id);
  }
  return { reload: false, patches };
}


// Injected into the dev page: SSE full-reload + a RUNTIME-error overlay. The stream closes on pagehide: a page Chrome
// keeps in its back/forward cache would hold it open, and six of them use up the browser's six connections to this host
// (the seventh page then hangs blank, no error anywhere). Coming back from that cache reloads, so no edit is missed.
// Without the overlay an uncaught error (a throwing Custom, a bad ref) only hits the console and leaves a blank page;
// «ResizeObserver loop completed with undelivered notifications» is not one (the browser's note that a layout settled a
// frame later, with no error object behind it): covering the page with it hid working screens (a TableView on a phone). this surfaces it like Vite, with the stack
// (source maps attribute frames to the .muten file). Compile errors use the server-side overlay() instead.
const devClient = (token: string): string => `<script>window.__MUTEN_DEV_TOKEN=${JSON.stringify(token)};(function(){function show(m){var d=document.getElementById('__mu_err');if(!d){d=document.createElement('div');d.id='__mu_err';document.body.appendChild(d);}d.style.cssText='position:fixed;inset:0;z-index:99999;background:#1a1a1f;color:#ffb4b4;font:13px/1.6 ui-monospace,monospace;overflow:auto';d.innerHTML='<div style="padding:16px 24px;background:#2a1416;color:#ff6b6b;font-weight:600;border-bottom:1px solid #471c1f">muten \\u2014 runtime error</div><pre style="padding:24px;white-space:pre-wrap">'+String(m).replace(/[<&]/g,function(c){return c==='<'?'&lt;':'&amp;';})+'</pre>';}
function place(s){try{fetch('/_muten/error',{method:'POST',headers:{'x-muten-token':window.__MUTEN_DEV_TOKEN,'content-type':'application/json'},body:JSON.stringify({stack:String(s)})}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.text)show(j.text)}).catch(function(){})}catch(_){}}
addEventListener('error',function(e){if(!e.error&&/^ResizeObserver loop/.test(e.message||''))return;var s=(e.error&&e.error.stack)||e.message;show(s);place(s);});
addEventListener('unhandledrejection',function(e){var s=(e.reason&&e.reason.stack)||String(e.reason);show('Unhandled promise rejection:\\n'+s);place(s);});
if(self===top){var __es=new EventSource('/_reload');__es.onmessage=function(e){var m;try{m=JSON.parse(e.data)}catch(_){return location.reload()}if(m.type==='css'){var l=document.querySelector('link[href^="/assets/boot.css"]');if(l){var n=l.cloneNode(false);n.setAttribute('href','/assets/boot.css?v='+Date.now());n.onload=function(){l.remove()};l.parentNode.insertBefore(n,l.nextSibling);}return;}if(m.type!=='patch')return location.reload();var rt=window.__muten_rt,pg=window.__muten_page;if(!rt||!pg||window.__muten_screen!==m.screen)return location.reload();try{for(var i=0;i<m.patches.length;i++){var p=m.patches[i],b=eval('('+p.src+')');if(!rt.patchNode(pg,p.id,function(c,par,n){return b(c,n,par,rt)}))return location.reload();}}catch(err){console.error('[muten hmr]',err);location.reload();}};addEventListener('pagehide',function(){__es.close()});addEventListener('pageshow',function(e){if(e.persisted)location.reload()});};})();</script>`;


// `muten dev` on esbuild: an incremental JS build kept fully IN MEMORY (write:false → nothing is written to
// the project, no `.muten-dev/` folder) + the CSS rebuilt each pass + a tiny static server with SPA fallback +
// SSE full-reload. On any .muten/.store/theme/muten.config change: refresh the model, rebuild JS + CSS, reload
// the browser — the same coarse-but-correct HMR the Vite plugin used. Oracle errors surface as an overlay.
export interface DevOptions { port: number; lan: boolean; hosts: string[] }

export async function devEsbuild(root: string, options: DevOptions = { port: 5173, lan: false, hosts: [] }): Promise<void> {
  const { port } = options;
  const token = devToken(); // this run's secret: the page gets it in its dev client, a page on another origin never does
  // an app that cannot even load (a broken app.muten, muten.config or theme.muten) keeps the server up with the error on
  // the page, and loads again on the next save, instead of ending the process
  let model: Awaited<ReturnType<typeof loadModel>>;
  for (;;) {
    try { model = await loadModel(root); break; }
    catch (e) {
      const message = describeFailure(e, root);
      console.error('\n  \x1b[31m✗\x1b[0m ' + message + '\n  waiting for a fix… (save to retry)');
      await waitForFix(root, port, options.lan ? undefined : '127.0.0.1', message);
    }
  }
  const outdir = join(root, '.muten-dev'); // a virtual base for output paths only — write:false, so nothing hits disk
  const ctx = await esbuild.context({
    entryPoints: { boot: join(root, 'src', 'app.muten') },
    bundle: true, format: 'esm', splitting: true, sourcemap: true, write: false, ...libraryOptions(root, true),
    define: { __MUTEN_DEV__: 'true', ...envDefines(root), ...libraryOptions(root, true).define }, // dev: keep the __muten_rt registry (HMR patch + DevTools reach the runtime through it)
    // entry stays unhashed (index.html references /assets/boot.js); SHARED CHUNKS must be hashed, or ≥2 of them
    // (e.g. the runtime + a shared lib like fruta) both land on assets/chunk.js and esbuild aborts the dev build.
    outdir, entryNames: 'assets/[name]', chunkNames: 'assets/[name]-[hash]', assetNames: 'assets/[name]',
    publicPath: '/', logLevel: 'silent', plugins: [mutenEsbuild(root, model, true)], // dev: HMR registry on
  });

  const clients = new Set<ServerResponse>();
  let lastError = '';
  let files = new Map<string, Uint8Array>(); // url -> bytes (boot.js, route chunks, source maps), all in memory
  let cssBytes: Buffer | null = null;
  const rebuild = async (): Promise<void> => {
    try {
      Object.assign(model, await loadModel(root));
      const result = await ctx.rebuild();
      const next = new Map<string, Uint8Array>();
      for (const f of result.outputFiles ?? []) next.set('/' + relative(outdir, f.path).replace(/\\/g, '/'), f.contents);
      files = next;
      const css = await buildCss(root, model);
      cssBytes = css ? Buffer.from(css) : null;
      forgetIssues();   // the devtools' Issues read check again after this build
      if (lastError) console.log('  \x1b[32m✓\x1b[0m fixed');
      lastError = '';
    } catch (e) {
      const errs = buildFailureErrors(e);
      if (errs) {
        // terminal: the same file:line:col + code frame Vite shows; overlay: the plain version (no ANSI).
        console.error('\n' + (await esbuild.formatMessages(errs, { kind: 'error', color: true, terminalWidth: 100 })).join('\n'));
        lastError = (await esbuild.formatMessages(errs, { kind: 'error', color: false })).join('\n');
      } else {
        lastError = describeFailure(e, root);
        console.error('\n  \x1b[31m✗\x1b[0m ' + lastError);
      }
    }
  };
  await rebuild();

  // HMR: cache the last compiled Doc per page; on a single-page edit, diff it and try a surgical patch, else reload.
  const docCache = new Map<string, Doc>();
  // Every page's doc, read once in the background as the server starts: the FIRST edit of a session can then be a
  // patch too (with no previous doc to compare against, it used to reload the page and drop its state).
  void (async (): Promise<void> => {
    for (const route of model.appIr?.routes || []) {
      const path = join(root, 'src', 'pages', route.page, route.page + '.muten');
      if (docCache.has(path) || !existsSync(path)) continue;
      try { docCache.set(path, (await load(path, model.parts)).doc); } catch { /* a page that does not compile yet: its first good edit reloads */ }
    }
  })();
  const reload = (): void => { for (const c of clients) c.write('data: {"type":"reload"}\n\n'); };
  const notify = async (changed: string[]): Promise<void> => {
    if (lastError) return reload();
    // CSS-only change (styles.css/scss or theme.muten — nothing touches the Doc/JS): hot-swap the stylesheet instead
    // of reloading. A full reload resets scroll + re-inits every signal — brutal while dragging a color in the palette.
    if (changed.length && changed.every((f) => /styles\.(css|scss)$/.test(f) || /theme\.muten$/.test(f))) {
      for (const c of clients) c.write('data: {"type":"css"}\n\n'); // rebuild() already refreshed cssBytes
      return;
    }
    const pages = changed.filter((f) => f.endsWith('.muten') && f.includes('pages'));
    if (pages.length !== 1) return reload(); // store/theme/config/multi-file edits: full reload
    try {
      const path = pages[0];
      const newDoc = (await load(path, model.parts)).doc;
      const oldDoc = docCache.get(path);
      docCache.set(path, newDoc);
      if (!oldDoc) return reload(); // a page the warm-up could not read (it did not compile): reload once, patch after
      const diff = diffDoc(oldDoc, newDoc);
      if (diff.reload || !diff.patches.length) return diff.reload ? reload() : undefined; // no visible change → no-op
      const opts = { stores: model.store.storesMeta, storeEntities: model.store.storeEntities, api: model.appIr?.api || {}, iconResolver: model.iconResolver, classes: model.classes, translations: model.translations, themeValues: model.themeValues, themeKit: model.themeKit };
      const patches = diff.patches.map((id) => ({ id, src: compileNodePatch(newDoc, id, opts) }));
      const msg = JSON.stringify({ type: 'patch', screen: newDoc.screen, patches });
      // Swap the (already-rebuilt) CSS too: a class-only edit can introduce a NEW Tailwind utility (a background, a color)
      // whose rule didn't exist before. The patch adds the class to the DOM node, but without re-fetching the stylesheet
      // the new class has NO rule → "I changed the background and nothing happened". The css hot-swap keeps state intact.
      for (const c of clients) { c.write('data: {"type":"css"}\n\n'); c.write(`data: ${msg}\n\n`); }
    } catch { reload(); }
  };

  const indexHtml = (): string => {
    let html = readIndexHtml(root, model);
    html = html.replace(/<script\s+type="module"\s+src="\/src\/app\.muten"\s*><\/script>/, '<script type="module" src="/assets/boot.js"></script>');
    if (cssBytes) html = html.replace('</head>', '  <link rel="stylesheet" href="/assets/boot.css">\n</head>');
    return html.replace('</body>', () => `  ${devClient(token)}\n</body>`);
  };
  const overlay = (): string => `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#1a1a1f;color:#f5f5f5;font:14px/1.6 ui-monospace,monospace">`
    + `<div style="padding:16px 24px;background:#2a1416;color:#ff6b6b;font-weight:600;border-bottom:1px solid #471c1f">muten — compile error</div>`
    + `<pre style="padding:24px;white-space:pre-wrap;color:#ffb4b4">${lastError.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</pre>`
    + `<script>const es=new EventSource('/_reload');es.onmessage=()=>location.reload();addEventListener('pagehide',()=>es.close())</script></body>`;

  // A side effect (open in editor) needs a POST carrying this run's token in a header: a link, an <img> or a form on another
  // site can send neither, and the browser will not let a script on another origin add the header without asking us first.
  // THIS MACHINE ONLY: a request that came in through a proxy or tunnel (dev.example.com → localhost) carries its headers,
  // and one from the wifi carries another address. The page served through a tunnel holds the token too, so the token
  // alone is not enough for what touches the machine.
  const fromThisMachine = (req: IncomingMessage): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')
    && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['forwarded'];
  const trusted = (req: IncomingMessage): boolean => req.method === 'POST' && req.headers['x-muten-token'] === token && fromThisMachine(req);
  const httpServer = createServer(async (req, res) => {
    const url = (req.url || '/').split('?')[0];
    res.setHeader('Cache-Control', 'no-cache'); // dev: assets change on every edit (boot.css has no hash); never let the browser serve a stale copy
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // DNS rebinding: a page on a domain that resolves to 127.0.0.1 would read every endpoint here. Only this machine's
    // names, IP literals and the names the app listed (`dev { hosts [...] }`) get an answer.
    if (!hostAllowed(req.headers.host, options.hosts)) {
      res.statusCode = 403; res.setHeader('Content-Type', 'text/plain');
      res.end(`muten dev: host "${String(req.headers.host || '').replace(/[^\w.:-]/g, '')}" is not allowed. Add it to muten.config: dev { hosts ["${String(req.headers.host || '').replace(/:\d+$/, '').replace(/[^\w.-]/g, '')}"] }`);
      return;
    }
    if (url === '/_reload') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url === '/_qr') { // dev-only: the LAN URL as a scannable code — open on the desktop, scan with a phone
      const addr = httpServer.address(), bound = addr && typeof addr === 'object' ? addr.port : port;
      res.setHeader('Content-Type', HTML_UTF8);
      res.end(qrPage(lanAddresses()[0], bound));
      return;
    }
    if (url === '/_muten/graph') { // the live app graph (routes/stores/parts) — an AI reads the structure without parsing files
      // the whole app's structure: this machine only (curl on localhost works; the wifi and a tunnel get nothing)
      if (!fromThisMachine(req)) { res.statusCode = 403; res.end('{"error":"the app graph is served to this machine only"}'); return; }
      res.setHeader('Content-Type', 'application/json');
      try { res.end(JSON.stringify(await mapApp(root), null, 2)); }
      catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); }
      return;
    }
    const answer = url.startsWith('/_muten/') ? await devtoolsAnswer(root, url, new URLSearchParams((req.url || '').split('?')[1] || '')) : false;
    if (answer !== false) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer)); return; }   // the devtools' questions (devtools-server.ts)
    if (url === '/_muten/error') {   // dev-only: a browser error's stack, read back to the .muten line (dev-errors.ts)
      res.setHeader('Content-Type', 'application/json');
      if (!trusted(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden"}'); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > ERROR_BODY_MAX) { res.statusCode = 413; res.end('{"ok":false}'); return; } }
      let stack = '';
      try { const parsed: unknown = JSON.parse(body); if (parsed && typeof parsed === 'object' && 'stack' in parsed && typeof parsed.stack === 'string') stack = parsed.stack; } catch { stack = ''; }
      const placed = placeRuntimeError(stack, files, root, outdir);
      try { mkdirSync(join(root, '.muten'), { recursive: true }); writeFileSync(join(root, LAST_ERROR), placed.text); } catch { /* the report just won't have it */ }   // for `muten report`
      res.end(JSON.stringify(placed));
      return;
    }
    if (url === '/_muten/fix') {   // the devtools' Fix: one finding's fix, only where its word still is (as check --fix)
      res.setHeader('Content-Type', 'application/json');
      if (!trusted(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden"}'); return; }
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      const abs = appFile(root, qs.get('file') || '');
      const line = Number(qs.get('line')), col = Number(qs.get('col')), from = qs.get('from') || '', to = qs.get('to') || '';
      if (!abs || !/\.(muten|store)$/.test(abs) || !from || !to || !(line > 0) || !(col > 0)) { res.statusCode = 400; res.end('{"ok":false}'); return; }
      const lines = readFileSync(abs, 'utf8').split('\n');
      const text = lines[line - 1] ?? '';
      if (!text.startsWith(from, col - 1)) { res.statusCode = 409; res.end('{"ok":false,"error":"the word is no longer there"}'); return; }
      lines[line - 1] = text.slice(0, col - 1) + to + text.slice(col - 1 + from.length);
      writeFileSync(abs, lines.join('\n'));
      res.end('{"ok":true}');
      return;
    }
    if (url === '/__muten_open') { // dev-only: open a .muten file at a line in the user's editor (DevTools "open in editor")
      res.setHeader('Content-Type', 'application/json');
      if (!trusted(req)) { res.statusCode = 403; res.end('{"ok":false,"error":"forbidden"}'); return; }
      const qs = new URLSearchParams((req.url || '').split('?')[1] || '');
      // a part is named, not filed, in the page: its file is found here (the devtools' «Open in editor» on a part)
      let file = qs.get('file') || '';
      const part = qs.get('part');
      if (part) { const found = (await loadAllParts(root))[part]?.file; file = found ? relative(root, found) : ''; }
      try { if (openInEditor(root, file, qs.get('line') || '1')) { res.end('{"ok":true}'); return; } } catch { /* spawn refused */ }
      res.statusCode = 404; res.end('{"ok":false,"error":"not found"}');
      return;
    }
    if (lastError) { res.setHeader('Content-Type', HTML_UTF8); res.end(overlay()); return; }
    if (url === '/assets/boot.css' && cssBytes) { res.setHeader('Content-Type', 'text/css'); res.end(cssBytes); return; }
    const mem = files.get(url);
    if (mem) { res.setHeader('Content-Type', MIME[extname(url)] || 'application/octet-stream'); res.end(Buffer.from(mem)); return; }
    // public assets (favicons, /docs, /code) come from disk, and ONLY from inside public/, never a secret (dev-security.ts)
    const pub = url === '/' ? null : fileInside(join(root, 'public'), url);
    if (pub) { res.setHeader('Content-Type', MIME[extname(pub)] || 'application/octet-stream'); res.end(readFileSync(pub)); return; }
    res.setHeader('Content-Type', HTML_UTF8); res.end(indexHtml()); // SPA fallback
  });
  // the configured port may be taken (another app, a stale server) — fall back to a free OS-assigned port instead of
  // crashing, and ALWAYS print the port actually bound so a parent process can read it back.
  httpServer.on('error', (e: NodeJS.ErrnoException) => { if (e.code === 'EADDRINUSE') { console.log(`  port ${port} is busy — using a free port instead`); httpServer.listen(0, options.lan ? undefined : '127.0.0.1'); } else throw e; });
  httpServer.on('listening', () => {
    const a = httpServer.address(); const bound = a && typeof a === 'object' ? a.port : port;
    console.log(`  muten dev (esbuild) → http://localhost:${bound}/`);
    if (options.lan) {
      for (const lan of lanAddresses()) console.log(`                      → http://${lan}:${bound}/  (phone, same wifi)`);
      if (lanAddresses().length) console.log(`  on your phone       → http://localhost:${bound}/_qr  (scan it)`);
      console.log('  \x1b[33m!\x1b[0m open to the network (--host): anyone on this wifi can load the app');
    } else console.log('  (this machine only; `muten dev --host` to open it to a phone on the same wifi)');
    devKeys(root, `http://localhost:${bound}/`);   // o / c / h / q, in a terminal (dev-keys.ts)
  });
  httpServer.listen(port, options.lan ? undefined : '127.0.0.1');

  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = new Set<string>();
  const onChange = (file: string): void => {
    if (file) changed.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => { const batch = [...changed]; changed.clear(); await rebuild(); await notify(batch); }, 40);
  };
  watch(join(root, 'src'), { recursive: true }, (_e, f) => onChange(f ? join(root, 'src', f) : ''));
  for (const f of ['theme.muten', 'muten.config']) { const p = join(root, f); if (existsSync(p)) watch(p, () => onChange(p)); }
  // The engine itself and the app's @muten/* packages (a component library's kit.css, a plugin's scripts): a change there
  // used to need a restart of `muten dev`. Linked packages (`file:`) resolve to their real folder; their own
  // node_modules are left alone.
  const watched = new Set<string>([here]);
  const scope = join(root, 'node_modules', '@muten');
  if (existsSync(scope)) for (const name of readdirSync(scope)) { try { watched.add(realpathSync(join(scope, name))); } catch { /* a dangling link */ } }
  for (const dir of watched) {
    try { watch(dir, { recursive: true }, (_e, f) => { if (f && !String(f).includes('node_modules') && /\.(js|css|json)$/.test(String(f))) onChange(join(dir, String(f))); }); } catch { /* a folder that cannot be watched: the old restart still works */ }
  }
}
