// The generic pieces an app used to write in .ts/.js, now muten's: files, the address bar, the clock and the scroll,
// Esc, a slider's fill, sound, money fields, libraries by <script>. Each is run in Chrome by the kit lab outside the repo;
// this pins what the compiler writes and what check says.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule } from '#engine/compile/compile.js';
import { scriptOrigins, withScriptOrigins, DEFAULT_CSP } from '../dist/dev-security.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const page = (body) => toDoc(parse(`screen p\n${body}`));
const codes = (body) => validate(page(body), {}).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code + (d.suggestion ? '>' + d.suggestion : ''));
const js = (body) => compileModule(page(body), {}, '', {}, {}, {});

// ── files ──
const files = 'state { photo = null : file  photos = [] : list<file>  saved = "" : text }\naction save() mutates saved { post "/media" body { photo: resize(photo, 1600) } into saved }\nPage { File bind(photo) accept("image/*") "Subir"  File bind(photos) "Varias"  when photo { Image "{preview(photo)}" alt("")  Text "{photo.name} {photo.size}" } }';
ok('a file state, File bound to it, its name and size, preview and resize check clean', codes(files).length === 0, codes(files).join());
const filesJs = js(files);
ok('File is a drop zone that filters by accept; a list<file> takes several', filesJs.includes("__in.accept = \"image/*\"") && filesJs.includes('__in.multiple = true') && filesJs.includes("addEventListener('drop'"));
ok('post sends what it is given as a form when it holds a file (__payload)', filesJs.includes('function __payload(body)') && filesJs.includes('new FormData()'));
ok('a file tells only its name, size and type', codes('state { photo = null : file }\nPage { Text "{photo.nmae}" }').join() === 'unknown-member>name');
ok('File binds a file state', codes('state { photo = "" : text }\nPage { File bind(photo) "x" }').includes('bind-type'));

// ── the address bar ──
const urlJs = js('action open() { url.set({ s: "pagos" }) }\nPage { Text "{url.s} {url.path}"  Button "x" -> open }');
ok('url.s / url.path read the address, url.set writes a history step, with no mutates', codes('action open() { url.set({ s: "pagos" }) }\nPage { Text "{url.s}"  Button "x" -> open }').length === 0 && urlJs.includes('__urlRead("s")') && urlJs.includes('__urlSet({ "s": "pagos" })'));
ok('a page state named url keeps its name', !js('state { url = "x" : text }\nPage { Text "{url}" }').includes('__urlRead'));

// ── the clock, the scroll, Esc, the slider, sound ──
ok('device.now / scrollY / scrollDir are device members', codes('Page { Text "{device.now} {device.scrollY} {device.scrollDir}" }').length === 0);
ok('on(escape) listens on the page while the node is there', js('state { o = true : bool }\naction c() mutates o { o.set(false) }\nPage { Stack on(escape: c) { Text "x" } }').includes("document.addEventListener('keydown', __esc); onCleanup("));
ok('Range says --value and --fill', js('state { v = 1 : number }\nPage { Range bind(v) "Volumen" }').includes("style.setProperty('--fill'"));
ok('Audio is the browser\'s player; play() and scrollTo() are built-ins', js('action r() { play("/a.mp3") scrollTo("#x") }\nPage { Audio "/a.mp3" controls  Button "x" -> r }').match(/createElement\('audio'\)|<audio class=\\"mu-audio\\"[^>]*controls/) && codes('action r() { play("/a.mp3") scrollTo("#x") }\nPage { Button "x" -> r }').length === 0);

// ── money ──
const money = js('state { price = 0 : number }\nPage { Number bind(price) currency("COP") "Precio" }');
ok('Number currency(…) is a money field grouped by the page language', money.includes("style: 'currency', currency: \"COP\"") && money.includes("inputMode = 'decimal'"));

// ── libraries by <script> ──
const scripted = js('use google from script "https://accounts.google.com/gsi/client"\nstate { who = "" : text }\naction signedIn(a: text) mutates who { who.set(a) }\neffect { google.accounts.id.initialize({ client_id: "x", callback: signedIn }) google.accounts.id.renderButton(element("#g"), { theme: "outline" }) }\nPage { Stack id("g") }');
ok('a library by <script> is a global loaded on first call, its calls run as written, element() reaches the page', scripted.includes('const google = __script("https://accounts.google.com/gsi/client", "google");') && scripted.includes('function __script(url, name)') && scripted.includes('google.accounts.id.renderButton(__b_element("#g")') && !scripted.includes('import * as __pkg'));
const app = mkdtempSync(join(tmpdir(), 'muten-kit-'));
mkdirSync(join(app, 'src', 'pages', 'p'), { recursive: true });
writeFileSync(join(app, 'src', 'pages', 'p', 'p.muten'), 'screen p\nuse google from script "https://accounts.google.com/gsi/client"\nPage { Text "x" }');
const policy = withScriptOrigins(DEFAULT_CSP, scriptOrigins(app));
ok('the page\'s policy lets those origins run, frame and style, and nothing more', /script-src 'self' https:\/\/accounts\.google\.com/.test(policy) && /frame-src 'self' https:\/\/accounts\.google\.com/.test(policy) && !policy.includes('*'), policy);

if (f) { console.log(`\n✗ ${f} failed`); process.exit(1); }
console.log('\n✓ kit: all passed');
