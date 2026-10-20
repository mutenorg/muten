// The app's texts: src/lang/<code>.lang as data, t("key", …) in muten, the `lang` store, and what check says.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { compileModule } from '#engine/compile/compile.js';
import { parseLang, readTranslations } from '#engine/project/lang-files.js';
import { checkLang, checkLangText } from '#engine/project/lang-check.js';
import { __t } from '../dist/runtime-lang.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const throwsAt = (fn) => { try { fn(); return null; } catch (e) { return e.loc ? `${e.loc.line}:${e.loc.col}` : 'no loc'; } };

// ── the file ──
const es = parseLang('# comentario\nhello  "Hola, {0}"\ncart.items "{0} producto | {0} productos"\n');
ok('a .lang file is key "text" per line, dotted keys, comments skipped', es.texts.hello === 'Hola, {0}' && es.texts['cart.items'] === '{0} producto | {0} productos' && es.locs.hello.line === 2);
ok('a key without its text in quotes is located', throwsAt(() => parseLang('a "x"\nb Hola')) === '2:3');
ok('a key written twice is located at the second', throwsAt(() => parseLang('a "x"\na "y"')) === '2:1');

// ── the runtime ──
const table = { es: { hello: 'Hola, {0}', items: '{0} producto | {0} productos', only: 'solo es' }, en: { hello: 'Hello, {0}', items: '{0} item | {0} items' } };
ok('t fills {0}', __t('en', table, 'hello', 'Ana') === 'Hello, Ana');
ok('a | b picks singular for 1, plural otherwise', __t('es', table, 'items', 1) === '1 producto' && __t('es', table, 'items', 3) === '3 productos' && __t('es', table, 'items', 0) === '0 productos');
ok('a key the language lacks falls back to another, then to the key', __t('en', table, 'only') === 'solo es' && __t('en', table, 'nope') === 'nope');

// ── compile: each page carries only its texts ──
const translations = { es: { hello: 'Hola, {0}', 'plan.free': 'Gratis', 'plan.pro': 'Pro', unused: 'nunca' }, en: { hello: 'Hello, {0}', 'plan.free': 'Free', 'plan.pro': 'Pro', unused: 'never' } };
const page = (body) => toDoc(parse(`screen p\nstate { name = "Ana" : text  tier = "free" : text }\n${body}`));
const js = compileModule(page('Stack { Text "{t("hello", name)}"  Text "{t("plan.{tier}")}" }'), {}, '', {}, {}, { translations });
ok('t() compiles to the runtime lookup in the app language', js.includes('__t(__lang().get(), __T, "hello", name.get())'), js.match(/__t\([^)]*\)/)?.[0]);
ok('the table has the keys used and the ones a run-time key fits, never the rest', js.includes('"plan.pro"') && js.includes('"hello"') && !js.includes('unused'));
ok('every page lists the languages (a switcher needs them)', js.includes('__langInit(["es","en"])'));
const switcher = compileModule(page('Button "{lang.current}" -> flip\naction flip() { lang.use("en") }'.replace('Button', 'action x() { }\nStack { Button').replace('-> flip', '-> flip }')), {}, '', {}, {}, { translations });
ok('lang.current reads the live language, lang.use() changes it', switcher.includes('__lang().get()') && switcher.includes('__langUse("en")'), switcher.slice(0, 400));
const other = compileModule(toDoc(parse('screen p\nstate { shop = "es" : text }\nlang from shop\nText "{t("hello", "x")}"')), {}, '', {}, {}, { translations });
ok('a page with `lang from <expr>` speaks that language instead', other.includes('__t(shop.get(), __T, "hello"'), other.match(/__t\([^)]*\)/)?.[0]);
const own = compileModule(toDoc(parse('screen p\nuse t from "./i18n.ts"\nText "{t("x")}"')), {}, '', {}, {}, { translations });
ok('a `use t` of its own wins (an app mid-move keeps working)', !own.includes('__T') && /\bt\("x"\)/.test(own), own.match(/t\("x"\)/)?.[0]);
const none = compileModule(toDoc(parse('screen p\nText "hi"')), {}, '', {}, {}, {});
ok('an app with no src/lang ships nothing of it', !none.includes('__lang'));

// ── validate ──
const codes = (body) => validate(page(body), { translations }).diagnostics.map((d) => d.code + (d.suggestion ? '>' + d.suggestion : ''));
ok('a key no language has, with the closest one', codes('Text "{t("helo", name)}"').join() === 't-unknown-key>hello', codes('Text "{t("helo", name)}"').join());
ok('a text that fills a value the call does not pass', codes('Text "{t("hello")}"').join() === 't-values');
ok('a run-time key no key fits', codes('Text "{t("tier.{tier}")}"').join() === 't-unknown-key');
ok('a run-time key that fits is fine, and so is lang.current', codes('Text "{t("plan.{tier}")} {lang.current}"').join() === '');
ok('without src/lang, t and lang are unknown names', validate(page('Text "{t("x")}"'), {}).diagnostics.some((d) => d.code === 'unknown-function'));

// ── check: the files against each other ──
const app = mkdtempSync(join(tmpdir(), 'muten-lang-'));
mkdirSync(join(app, 'src', 'lang'), { recursive: true });
writeFileSync(join(app, 'src', 'lang', 'es.lang'), 'hello "Hola, {0}"\nbye "Chao"\n');
writeFileSync(join(app, 'src', 'lang', 'en.lang'), 'hello "Hello"\n');
writeFileSync(join(app, 'src', 'lang', 'english.lang'), 'hello "Hello, {0}"\nbye "Bye"\n');
const found = checkLang(app).map((d) => d.file + ':' + d.code);
ok('a language that lacks a key another has', found.includes('src/lang/en.lang:lang-missing'), found.join());
ok('a text that fills other values than its translation', found.includes('src/lang/es.lang:lang-values') || found.includes('src/lang/en.lang:lang-values'), found.join());
ok('a file not named by a language code', found.includes('src/lang/english.lang:lang-code'), found.join());
ok('the editor checks unsaved text against the files on disk', checkLangText(app, join(app, 'src', 'lang', 'en.lang'), 'hello "Hello, {0}"\nbye "Bye"').length === 0);
ok('readTranslations reads every language; no src/lang reads as none', Object.keys(readTranslations(app) || {}).length === 3 && readTranslations(mkdtempSync(join(tmpdir(), 'muten-nolang-'))) === undefined);

if (f) { console.log(`\n✗ ${f} failed`); process.exit(1); }
console.log('\n✓ lang: all passed');
