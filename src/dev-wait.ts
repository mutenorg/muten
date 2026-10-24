// dev-wait: what `muten dev` does when the app cannot even load (a broken app.muten, muten.config or theme.muten).
// The process used to die, so the terminal showed the error once and the browser only «connection refused». Now the
// server stays up on its port with the error on the page, watches the app, and gives way to the real dev server as
// soon as a fix is saved; the page notices and reloads into the app by itself.
import { createServer } from 'node:http';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

const HTML_UTF8 = 'text/html; charset=utf-8';
// the header that tells the waiting page it is still talking to this server, not to the app's
const WAITING = 'x-muten-waiting';
const SETTLE_MS = 150;   // an editor saves in bursts: one retry per burst
const POLL_MS = 800;

const escapeHtml = (text: string): string => text.replace(/[<&>]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

function page(message: string): string {
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>muten — the app could not load</title>'
    + '<body style="margin:0;min-height:100vh;background:#1a1a1f;color:#f1f1f3;font:14px/1.6 ui-monospace,monospace">'
    + '<div style="padding:16px 24px;background:#2a1416;color:#ff8a80;font-weight:600;border-bottom:1px solid #471c1f">muten — the app could not load</div>'
    + `<pre style="margin:0;padding:24px;white-space:pre-wrap">${escapeHtml(message)}</pre>`
    + '<p style="padding:0 24px;color:#9a9aa3">Fix it and save: this page reloads into the app by itself.</p>'
    + `<script>setInterval(function(){fetch(location.href,{method:'HEAD',cache:'no-store'}).then(function(r){if(!r.headers.get('${WAITING}'))location.reload();}).catch(function(){});},${POLL_MS});</script>`
    + '</body>';
}

/** Serves `message` on `port` until a file of the app changes, then frees the port and resolves. */
export function waitForFix(root: string, port: number, host: string | undefined, message: string): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', HTML_UTF8);
      res.setHeader('cache-control', 'no-store');
      res.setHeader(WAITING, '1');
      res.end(page(message));
    });
    server.on('error', () => { /* the port is taken: the terminal still shows the error, and saving still retries */ });
    server.listen(port, host);
    const watchers: FSWatcher[] = [];
    let timer: NodeJS.Timeout | undefined;
    const retry = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const w of watchers) w.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }, SETTLE_MS);
    };
    const src = join(root, 'src');
    if (existsSync(src)) watchers.push(watch(src, { recursive: true }, retry));
    for (const file of ['theme.muten', 'muten.config']) { const path = join(root, file); if (existsSync(path)) watchers.push(watch(path, retry)); }
  });
}
