// Security: what keeps `muten dev` from handing the project out, and what keeps a link built from data from running code.
// Each check is a hole that existed: a `../` path read api/.env over the wifi, a `line` parameter reached a shell, a
// `javascript:` href came straight from a database row, and the app graph shipped in dist/.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileInside, hostAllowed, isSecretPath, openInEditor, withCsp, cspFrom, DEFAULT_CSP, hostRuleProblem, securityHeaders, headersFrameProtected } from '../dist/dev-security.js';
import { BUILTINS_JS } from '#engine/compile/emit.js';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compileModule, compile } from '#engine/compile/compile.js';

let fails = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};

// ── a project on disk: public/ with an asset, and secrets beside it ──
const root = mkdtempSync(join(tmpdir(), 'muten-sec-'));
const pub = join(root, 'public');
mkdirSync(join(pub, 'img'), { recursive: true });
writeFileSync(join(pub, 'img', 'logo.svg'), '<svg/>');
writeFileSync(join(pub, 'robots.txt'), 'User-agent: *');
writeFileSync(join(pub, '.env'), 'SECRET=1');
writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://x');
mkdirSync(join(root, 'src'), { recursive: true });
writeFileSync(join(root, 'src', 'home.muten'), 'screen home');
symlinkSync(join(root, '.env'), join(pub, 'leak.txt'));

// public files: only inside public/, never a secret
check('serves a public file', fileInside(pub, '/img/logo.svg') === join(pub, 'img', 'logo.svg'));
check('serves robots.txt', fileInside(pub, '/robots.txt') !== null);
check('blocks ../ out of public/', fileInside(pub, '/../.env') === null);
check('blocks deep ../', fileInside(pub, '/img/../../src/home.muten') === null);
check('blocks encoded %2e%2e', fileInside(pub, '/%2e%2e/.env') === null);
check('blocks encoded %2f', fileInside(pub, '/..%2f.env') === null);
check('blocks a .env inside public/', fileInside(pub, '/.env') === null);
check('blocks a symlink pointing out of public/', fileInside(pub, '/leak.txt') === null);
check('blocks a NUL byte', fileInside(pub, '/robots.txt%00.png') === null);
check('blocks malformed escapes', fileInside(pub, '/%E0%A4%A') === null);
check('a folder is not a file', fileInside(pub, '/img') === null);
check('secret names', isSecretPath('keys/server.pem') && isSecretPath('.env.local') && isSecretPath('a/.git/config') && !isSecretPath('img/logo.svg'));
check('.well-known stays servable', !isSecretPath('.well-known/assetlinks.json'));

// hosts: this machine, IP literals and the app's own list; never another name (DNS rebinding)
check('localhost', hostAllowed('localhost:5173', []));
check('127.0.0.1', hostAllowed('127.0.0.1:5173', []));
check('a LAN IP literal', hostAllowed('192.168.1.20:5173', []));
check('ipv6 loopback', hostAllowed('[::1]:5173', []));
check('*.localhost', hostAllowed('app.localhost:5173', []));
check('an unknown name is refused', !hostAllowed('evil.example:5173', []));
check('no Host is refused', !hostAllowed(undefined, []));
check('an allowed tunnel name', hostAllowed('dev.storio.ink', ['dev.storio.ink']));
check('an allowed zone', hostAllowed('a.b.example.com', ['.example.com']) && hostAllowed('example.com', ['.example.com']));
check('a look-alike of an allowed name is refused', !hostAllowed('dev.storio.ink.evil.com', ['dev.storio.ink']));

// `dev { hosts }` rules that would let a stranger's domain in are refused before the server starts
check('accepts dev.storio.ink', hostRuleProblem('dev.storio.ink') === null);
check('accepts a zone .storio.ink', hostRuleProblem('.storio.ink') === null);
check('refuses *', hostRuleProblem('*') !== null);
check('refuses .com', hostRuleProblem('.com') !== null);
check('refuses a bare tld', hostRuleProblem('ink') !== null);
check('refuses *.storio.ink', hostRuleProblem('*.storio.ink') !== null);
check('refuses a scheme or port', hostRuleProblem('https://dev.storio.ink') !== null && hostRuleProblem('dev.storio.ink:5173') !== null);
check('refuses empty', hostRuleProblem('') !== null);

// open in editor: never a shell, never outside the app, never a secret
process.env.MUTEN_EDITOR = 'true'; // a harmless program, in case a valid case spawns
check('rejects a shell payload in line', openInEditor(root, 'src/home.muten', '1;touch /tmp/pwned') === false);
check('rejects a non-numeric line', openInEditor(root, 'src/home.muten', '$(id)') === false);
check('rejects ../', openInEditor(root, '../etc/passwd', '1') === false);
check('rejects an absolute path', openInEditor(root, '/etc/passwd', '1') === false);
check('rejects a secret', openInEditor(root, '.env', '1') === false);
check('rejects a file that does not exist', openInEditor(root, 'src/nope.muten', '1') === false);
check('opens the app\'s own source', openInEditor(root, 'src/home.muten', '12') === true);
check('no file was created by a payload', !existsSync('/tmp/pwned'));

// links built from data: no javascript:, no data: where only media belongs
const __safeUrl = new Function(BUILTINS_JS + '\nreturn __safeUrl;')();
const BLOCKED = 'about:blank#blocked';
check('javascript: blocked', __safeUrl('javascript:alert(1)', false) === BLOCKED);
check('JaVaScRiPt: blocked', __safeUrl('JaVaScRiPt:alert(1)', false) === BLOCKED);
check('java\\tscript: blocked', __safeUrl('java\tscript:alert(1)', false) === BLOCKED);
check('leading spaces + newline blocked', __safeUrl('  \njavascript:alert(1)', false) === BLOCKED);
check('vbscript: blocked', __safeUrl('vbscript:msgbox', false) === BLOCKED);
check('data:text/html in a link blocked', __safeUrl('data:text/html,<script>alert(1)</script>', false) === BLOCKED);
check('data:image in a link blocked', __safeUrl('data:image/png;base64,AAAA', false) === BLOCKED);
check('data:image in a src allowed', __safeUrl('data:image/png;base64,AAAA', true) === 'data:image/png;base64,AAAA');
check('data:image/svg in a src blocked', __safeUrl('data:image/svg+xml,<svg onload=alert(1)>', true) === BLOCKED);
check('https kept', __safeUrl('https://storio.ink/x', false) === 'https://storio.ink/x');
check('mailto/tel kept', __safeUrl('mailto:a@b.co', false) === 'mailto:a@b.co' && __safeUrl('tel:+57300', false) === 'tel:+57300');
check('app deep link kept', __safeUrl('whatsapp://send?phone=1', false) === 'whatsapp://send?phone=1');
check('relative path kept', __safeUrl('/product/12', false) === '/product/12' && __safeUrl('#top', false) === '#top');
check('empty stays empty', __safeUrl('', false) === '' && __safeUrl(null, false) === '');

// the compiler routes an interpolated href/src through __safeUrl, and leaves an authored one alone
const src = 'screen t\nstate { u = "" : text }\nPage { Link "go" -> "{u}"  Image "{u}" alt("x")  Link "home" -> "/home" }';
const js = compileModule(toDoc(parse(src)));
check('interpolated href goes through __safeUrl', /__bind\(el_\w+, "href", \(\) => __safeUrl\([^;]*, false\)\);/.test(js), js.slice(0, 400));
check('interpolated src goes through __safeUrl', /__bind\(el_\w+, "src", \(\) => __safeUrl\([^;]*, true\)\);/.test(js));
check('an authored href is left as written', js.includes('.href = "/home"') || js.includes('href=\\"/home\\"'), js.match(/__clone\([^)]*home[^)]*\)/)?.[0]); // a static link may go out inside a template clone


// a value spliced into a request url stays ONE path segment / ONE query value (no `../admin` with the user's session)
const reqJs = compileModule(toDoc(parse('screen t\nstate { id = "" : text  hook = "" : text  q = "" : text }\naction go { put "/bookings/{id}/pay?note={q}" body { a: 1 } }\naction ping { post "{hook}" body { a: 1 } }\nPage { Button "go" -> go  Button "p" -> ping }')));
check('path value goes through __seg', /__seg\(/.test(reqJs), reqJs.slice(reqJs.indexOf('__send'), reqJs.indexOf('__send') + 160));
check('query value is encodeURIComponent', /encodeURIComponent\(String\(/.test(reqJs));
check('a whole-url value is left whole', /__send\(String\(/.test(reqJs));
const __seg = new Function(BUILTINS_JS + '\nreturn __seg;')();
check('__seg encodes ../admin', __seg('../admin') === '..%2Fadmin');
check('__seg neutralizes .. and .', __seg('..') === '%2E%2E' && __seg('.') === '%2E');
check('__seg keeps a plain id', __seg('abc-123') === 'abc-123');

// the user's session only goes to the app's own origins; the live socket never puts it in the url
const liveJs = compileModule(toDoc(parse('screen t\nentity M { id text }\nstate { m = query msgs live : list<M> }\nsources { msgs: { url: "/messages/live" } }\nPage { Text "x" }')));
check('headers are scoped by url', /__hdrs\(q\.url\)|__hdrs\(url\)/.test(liveJs) || /__hdrs\(q\.url\)/.test(reqJs));
check('no bearer in the socket url', !/__all\.token/.test(liveJs) && !/__all\.token/.test(reqJs));
check('bearer as a subprotocol', /muten\.bearer\./.test(liveJs) || /muten\.bearer\./.test(reqJs));
const scope = new Function('location', 'globalThis', `const __API = { base: "https://api.app.com" }; ${reqJs.match(/const __OWN = [^\n]*/)[0]}\n${reqJs.match(/const __own = [^\n]*/)[0]}\n${reqJs.match(/const __hdrs = [^\n]*/)[0]}\nreturn __hdrs;`);
const hdrs = scope({ href: 'https://app.com/x', origin: 'https://app.com' }, { __mutenHeaders: () => ({ authorization: 'Bearer s3cret' }) });
check('session sent to the page origin', hdrs('https://app.com/me').authorization === 'Bearer s3cret');
check('session sent to the declared api base', hdrs('https://api.app.com/me').authorization === 'Bearer s3cret');
check('session sent on a relative url', hdrs('/me').authorization === 'Bearer s3cret');
check('session NOT sent to a third party', hdrs('https://api.giphy.com/v1').authorization === undefined);
check('session NOT sent to a look-alike', hdrs('https://api.app.com.evil.io/x').authorization === undefined);

// the production page's Content-Security-Policy
const shell = '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/a.js"></script></body></html>';
check('csp "default" is the default policy', cspFrom({ csp: 'default' }) === DEFAULT_CSP && cspFrom({ csp: 'off' }) === '' && cspFrom(undefined) === null);
check('csp meta injected into <head>', /<head><meta charset="utf-8">|<head>\n  <meta http-equiv="Content-Security-Policy"/.test(withCsp(shell, DEFAULT_CSP)) && withCsp(shell, DEFAULT_CSP).includes("script-src 'self'"));
check('an app\'s own csp is kept', withCsp(shell.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="x">'), DEFAULT_CSP).split('Content-Security-Policy').length === 2);
const inline = shell.replace('</body>', '<script type="module">console.log(1)</script><script type="application/ld+json">{"a":1}</script></body>');
const withHash = withCsp(inline, DEFAULT_CSP);
check('an inline module muten wrote is allowed by hash', /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/.test(withHash));
check('JSON-LD is not hashed (data, not code)', (withHash.match(/sha256-/g) || []).length === 1);

// the host's headers: nobody frames the app unless the app says so
const hdr = securityHeaders(undefined);
check('default headers refuse other sites framing the app', hdr.includes("frame-ancestors 'self'") && hdr.includes('X-Frame-Options: SAMEORIGIN'));
check('default headers carry nosniff + HSTS', hdr.includes('nosniff') && hdr.includes('Strict-Transport-Security'));
check('frame "deny" → none', securityHeaders({ frame: 'deny' }).includes("frame-ancestors 'none'"));
check('headers "off" → nothing', securityHeaders({ headers: 'off' }) === null);
check('an app _headers without frame protection is flagged', !headersFrameProtected('/*\n  X-Content-Type-Options: nosniff') && headersFrameProtected("/*\n  Content-Security-Policy: frame-ancestors 'self'"));

// persisted state: a stored value of the wrong type falls back (a planted string never becomes the app's list or flag)
const persistJs = compileModule(toDoc(parse('screen t\nstate { n = 0 : num persist  tags = [] : list<text> persist }\nPage { Text "{n}" }')));
const loadSrc = persistJs.match(/const __loadLocal = [^\n]*/);
check('the page reads persisted state through the type-checked loader', !!loadSrc, persistJs.slice(0, 200));
if (loadSrc) {
  const store = { k: '' };
  const fake = { localStorage: { getItem: () => store.k } };
  const load = new Function('localStorage', loadSrc[0] + '; return __loadLocal;')(fake.localStorage);
  store.k = '"<img src=x onerror=alert(1)>"'; check('a string planted where a number lives → the default', load('k', 0) === 0);
  store.k = '{"length":1}'; check('an object planted where a list lives → the default', Array.isArray(load('k', [])));
  store.k = 'null'; check('null planted where an object lives → the default', load('k', { a: 1 }).a === 1);
  store.k = '7'; check('a value of the right type is kept', load('k', 0) === 7);
  store.k = '{bad json'; check('broken JSON → the default', load('k', 5) === 5);
}

// cookie sessions: api { credentials } reaches every fetch, so a session can live in an httpOnly cookie no script reads
const { sourceRequest } = await import('#engine/shared/source.js');
check('api { credentials: "include" } reaches the request', sourceRequest({ url: '/messages' }, { base: 'https://api.example.com', credentials: 'include' }).credentials === 'include');
check('credentials works without a base (same-origin API)', sourceRequest({ url: '/messages' }, { credentials: 'include' }).credentials === 'include');
check('an unknown credentials value is ignored', sourceRequest('/m', { base: 'https://a.b', credentials: 'everything' }).credentials === '');
const credJs = compile(toDoc(parse('screen s\nstate { ms = query models : list<text> }\nsources { models: { url: "/x" } }\nPage { each ms.data as m { Span "{m}" } }')), {}, '', {}, {}, { format: 'module' });
check('the runtime hands credentials to fetch', (credJs.match(/credentials: q\.credentials/g) || []).length >= 1);

// muten check: persisting a token or someone's personal data is flagged
const { validate } = await import('#engine/ir/validate.js');
const persistDiag = validate(toDoc(parse('screen t\nstate { token = "" : text persist  email = "" : text persist  tab = "a" : text persist }\nPage { Text "x" }')), { kind: 'page' });
const flagged = persistDiag.diagnostics.filter((d) => d.code === 'persist-sensitive').map((d) => d.message.split('"')[1]);
check('persisting "token" and "email" is warned about', flagged.includes('token') && flagged.includes('email'), JSON.stringify(flagged));
check('persisting a harmless tab is not', !flagged.includes('tab'));
check('the warning is a warning, not an error', persistDiag.diagnostics.filter((d) => d.code === 'persist-sensitive').every((d) => d.severity === 'warning'));

rmSync(root, { recursive: true, force: true });
console.log(fails ? `\n${fails} security check(s) FAILED` : '\nall security checks passed');
process.exit(fails ? 1 : 0);
