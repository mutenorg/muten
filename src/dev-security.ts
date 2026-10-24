// dev-security.ts: what keeps `muten dev` from handing the project to someone else. The dev server reads the whole
// project and can open files in the editor, so every way in is checked here, after what Vite learned the hard way:
//   · it binds localhost unless asked (`--host` / `dev { host "lan" }`), so the wifi cannot reach it;
//   · a request whose Host is a NAME that is not this machine's is refused (DNS rebinding: a page on evil.com that
//     resolves itself to 127.0.0.1 would otherwise read every dev endpoint);
//   · a public file is served only from INSIDE public/, and never a secret (.env, keys, dotfiles), whatever the path says;
//   · what has a side effect (open in editor) needs a POST with this run's token in a header — a page on another
//     origin can send neither, so a link or an <img> pointed at it does nothing.
// Consumed by dev-server.ts (devEsbuild) and esbuild-muten.ts (the CSP of a bundle). Pure helpers except openInEditor, which spawns the editor.

import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, statSync, realpathSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { readMutenConfig } from '#engine/project/config.js';
import { isAbsolute, join, relative, resolve, sep, extname, basename } from 'node:path';

// Files no dev server should ever hand out, whatever folder they sit in (Vite's `server.fs.deny`, widened).
const SECRET_NAMES: RegExp[] = [/^\.env(\..*)?$/i, /\.(pem|key|crt|cer|p12|pfx|jks|keystore)$/i, /^id_(rsa|ed25519|ecdsa|dsa)/i, /^\.npmrc$/i, /^\.netrc$/i];
// Only these open in the editor: the app's own source.
const EDITABLE = new Set(['.muten', '.store', '.js', '.ts', '.css', '.scss', '.json', '.html', '.md']);
// Host names that are always this machine.
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A fresh secret per `muten dev` run; the page gets it in its dev client, nobody else does. */
export function devToken(): string { return randomBytes(24).toString('hex'); }

/** Whether a path names something secret (any segment hidden, or a name on the deny list). */
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part.startsWith('.') && part !== '.well-known')) return true;
  const name = basename(path);
  return SECRET_NAMES.some((rule) => rule.test(name));
}

/** The real file under `dir` a URL path names, or null: outside `dir`, a secret, a folder, missing, or malformed. */
export function fileInside(dir: string, urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const base = resolve(dir);
  const target = resolve(base, '.' + (decoded.startsWith('/') ? decoded : '/' + decoded));
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (isSecretPath(relative(base, target))) return null;
  if (!existsSync(target) || statSync(target).isDirectory()) return null;
  // a symlink inside public/ that points outside it is outside it
  const real = realpathSync(target);
  const realBase = realpathSync(base);
  if (real !== realBase && !real.startsWith(realBase + sep)) return null;
  return target;
}

/** Whether a request's Host header names this machine or a name the app allowed (`dev { hosts [...] }`).
 *  An IP literal is always fine: DNS rebinding needs a domain NAME that resolves to us. */
export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, '');
  if (LOCAL_NAMES.has(host) || host.endsWith('.localhost')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:]+\]$/.test(host)) return true;
  return allowed.some((rule) => {
    const name = rule.trim().toLowerCase();
    if (!name) return false;
    return name.startsWith('.') ? host === name.slice(1) || host.endsWith(name) : host === name;
  });
}

/** The editor command, split into the program and its own flags: `MUTEN_EDITOR="code -r"` → ['code', '-r']. */
function editorCommand(): { program: string; args: string[] } {
  const words = (process.env.MUTEN_EDITOR || 'code').trim().split(/\s+/).filter(Boolean);
  return { program: words[0] || 'code', args: words.slice(1) };
}

/** Open `file` (relative to the app) at `line` in the editor, WITHOUT a shell: nothing in the request reaches one.
 *  Returns false when the file is not the app's own editable source or the line is not a number. */
/** `file` (relative to the app) as an absolute path when it is one of the app's own editable files, else null: inside
 *  the app, not a secret, not a package's, an extension an editor opens. What the devtools may open, or fix. */
export function appFile(root: string, file: string): string | null {
  if (!file || isAbsolute(file)) return null;
  const base = resolve(root);
  const abs = resolve(base, file);
  if (!abs.startsWith(base + sep) || isSecretPath(relative(base, abs)) || !EDITABLE.has(extname(abs).toLowerCase())) return null;
  if (abs.split(sep).includes('node_modules') || !existsSync(abs) || statSync(abs).isDirectory()) return null;
  return abs;
}

export function openInEditor(root: string, file: string, line: string): boolean {
  if (!/^\d{1,7}$/.test(line)) return false;
  const abs = appFile(root, file);
  if (!abs) return false;
  const { program, args } = editorCommand();
  const child = spawn(program, [...args, '-g', `${join(abs)}:${line}`], { shell: false, stdio: 'ignore', detached: true });
  child.on('error', () => { /* no editor on PATH: the request already answered */ });
  child.unref();
  return true;
}

// ── production: the Content-Security-Policy a bundle ships with ───────────────────────────────────────────────────
// What a page may load and run. `script-src 'self'` is the one that matters: an injected <script> or inline handler does
// not run. Styles allow 'unsafe-inline' because the runtime writes a <style> for its a11y helpers; images, media, fonts
// and API calls may come from any https origin (a CDN, an API), never from plain http.
export const DEFAULT_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' https: data: blob:", "media-src 'self' https: blob:",
  "connect-src 'self' https: wss:", "object-src 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

/** The policy muten.config asks for: `security { csp "default" }`, a policy string, or "off". null = not configured. */
export function cspFrom(security: { [key: string]: unknown } | undefined): string | null {
  const csp = security && typeof security === 'object' ? security.csp : undefined;
  if (csp === undefined || csp === null) return null;
  if (csp === 'off' || csp === false) return '';
  if (csp === 'default' || csp === true) return DEFAULT_CSP;
  return typeof csp === 'string' ? csp : null;
}

/** The sha256 source of every INLINE script the page runs (a JSON-LD block is data, not run), so the policy allows the
 *  code muten wrote into the page (an SSG page carries its module inline) and nothing anyone injects later. */
function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] || '';
    if (/\ssrc\s*=/i.test(attrs) || /type\s*=\s*["']?application\/(ld\+)?json/i.test(attrs)) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return out;
}

// the libraries an app loads by their own <script> (`use google from script "https://accounts.google.com/gsi/client"`)
const FROM_SCRIPT_URL = /from\s+script\s+"(https:\/\/[^"]+)"/g;
const SCRIPT_DIRECTIVES = ['script-src', 'frame-src', 'style-src'];   // its code, the frames it opens, the styles it brings

/** The origins of the libraries the app's .muten files load by <script>. */
export function scriptOrigins(appRoot: string): string[] {
  const origins = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path); continue; }
      if (!/\.(muten|store)$/.test(entry.name)) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(FROM_SCRIPT_URL)) { try { origins.add(new URL(match[1]).origin); } catch { /* not a URL: check says so */ } }
    }
  };
  walk(join(appRoot, 'src'));
  return [...origins];
}

/** The policy with those origins allowed to run their script, open their frames and bring their styles, and nothing else. */
export function withScriptOrigins(policy: string, origins: string[]): string {
  if (!policy || !origins.length) return policy;
  let out = policy;
  for (const directive of SCRIPT_DIRECTIVES) {
    const has = new RegExp(`(^|;\\s*)${directive}\\s`).test(out);
    out = has ? out.replace(new RegExp(`(${directive}[^;]*)`), (found) => `${found} ${origins.join(' ')}`) : `${out}; ${directive} 'self' ${origins.join(' ')}`;
  }
  return out;
}

/** index.html with the policy as a <meta> (an existing one is left alone: the app wrote its own). */
export function withCsp(html: string, policy: string): string {
  if (!policy || /http-equiv=["']content-security-policy["']/i.test(html)) return html;
  const hashes = inlineScriptHashes(html);
  const full = hashes.length ? policy.replace(/script-src([^;]*)/, (d) => `${d} ${hashes.join(' ')}`) : policy;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${full.replace(/"/g, '&quot;')}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => `${head}\n  ${meta}`) : meta + html;
}

/** Whether a `dev { hosts [...] }` entry is a NAME the app can own: a full domain (`dev.example.com`) or a zone of one
 *  (`.example.com`). Refused: `*`, a bare top-level domain (`.com`, `ink`), anything with a wildcard, a port, a path or
 *  a scheme. Each of those would let a stranger's domain reach the dev server (DNS rebinding), so muten will not start. */
export function hostRuleProblem(rule: string): string | null {
  const name = rule.trim().toLowerCase();
  if (!name) return 'is empty';
  if (/[*?]/.test(name)) return 'has a wildcard: list the exact name (dev.example.com) or a zone you own (.example.com)';
  if (/[/:@\s]/.test(name)) return 'must be a bare host name: no scheme, port or path (dev.example.com)';
  const labels = (name.startsWith('.') ? name.slice(1) : name).split('.');
  if (labels.some((label) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) return 'is not a valid host name';
  if (labels.length < 2) return 'is a whole top-level domain: anyone could register a name under it';
  return null;
}

// ── production: the response headers a static host should send (`_headers`, read by Cloudflare Pages and Netlify) ──
// A <meta> CSP cannot say who may frame the page; a header can. Without it any site can load the signed-in app in an
// invisible iframe under its own button (clickjacking). `security { frame "self" | "deny" | "any" }` picks who may frame
// it (default "self": the app may preview itself); `security { headers "off" }` writes nothing.
export function securityHeaders(security: { [key: string]: unknown } | undefined): string | null {
  const conf = security && typeof security === 'object' ? security : {};
  if (conf.headers === 'off' || conf.headers === false) return null;
  const frame = conf.frame === 'deny' ? "'none'" : conf.frame === 'any' ? null : "'self'";
  const lines = ['/*'];
  if (frame) lines.push(`  Content-Security-Policy: frame-ancestors ${frame}`, `  X-Frame-Options: ${frame === "'none'" ? 'DENY' : 'SAMEORIGIN'}`);
  lines.push('  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '  Strict-Transport-Security: max-age=31536000');
  // every file in /assets carries its content's hash in its name: a new version is a new name, so a browser may keep
  // each one for a year and never ask again (without it, every visit asked for every chunk once more)
  lines.push('', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable');
  return lines.join('\n') + '\n';
}

/** Whether an app's own `_headers` protects against framing (it is the app's, so it is kept, only checked). */
export function headersFrameProtected(text: string): boolean {
  return /frame-ancestors/i.test(text) || /x-frame-options/i.test(text);
}


// The host's response headers (dev-security.ts): written unless the app brought its own `_headers` in public/, which is
// kept as it is and only checked for the one thing a <meta> cannot do, refusing to be framed by another site.
export function writeSecurityHeaders(root: string, outDir: string): void {
  const file = join(outDir, '_headers');
  if (existsSync(file)) {
    if (!headersFrameProtected(readFileSync(file, 'utf8'))) console.log('  \x1b[33m!\x1b[0m public/_headers does not stop other sites from framing the app: add `Content-Security-Policy: frame-ancestors \'self\'`');
    return;
  }
  const text = securityHeaders(readMutenConfig(root).security);
  if (text) writeFileSync(file, text);
}
