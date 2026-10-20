// theme.muten as the manager of the look (one file connects a CSS library: its stylesheets, presets, extras, tokens,
// the classes it needs on <html>), and what `check` says about theme.muten and muten.config.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '#engine/lang/parse.js';
import { emitTheme } from '#engine/style/tokens.js';
import { themeLibrary, libraryImports, libraryTokens, withLibraryCss, themeRoot, withThemeRoot } from '#engine/project/theme-library.js';
import { checkThemeText } from '#engine/project/theme-check.js';
import { checkConfigText } from '#engine/project/config-check.js';
import { pluginNames } from '#engine/project/plugins.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };

// a library installed the way npm leaves it, with no muten-specific manifest
const app = mkdtempSync(join(tmpdir(), 'muten-theme-'));
const lib = join(app, 'node_modules', '@muten', 'fakeui');
mkdirSync(join(lib, 'themes'), { recursive: true });
writeFileSync(join(app, 'package.json'), '{"name":"app"}');
writeFileSync(join(lib, 'package.json'), '{"name":"@muten/fakeui","exports":{"./globals.css":"./globals.css"}}');
writeFileSync(join(lib, 'globals.css'), ':root { --primary: #000; --radius: 4px; }\n.dark { --primary: #fff; }\n.card { border-radius: var(--radius); }');
writeFileSync(join(lib, 'themes', 'noir.css'), ':root { --primary: #111; }');
writeFileSync(join(lib, 'nova.css'), '.style-nova .card { padding: 8px; }');
writeFileSync(join(lib, 'registry.json'), '{"components":[]}');

const source = 'theme fakeui {\n  preset noir\n  with nova\n  mode dark\n  primary "#6B46F2"\n  dark { primary "#8B6CF6" }\n  colors { brand "#ff0" }\n}';
const theme = parse(source).theme;
const found = themeLibrary(app, theme);
ok('the library is found by convention (no manifest, package exports hide package.json)', found?.pkg === '@muten/fakeui' && found.css.join() === 'globals.css', JSON.stringify(found));
ok('its presets and extras are its themes/ and its other stylesheets', JSON.stringify(Object.keys(found?.presets || {})) === '["noir"]' && JSON.stringify(Object.keys(found?.extras || {})) === '["nova"]');
ok('the stylesheets it brings: base, preset, extras, in order', JSON.stringify(libraryImports(found, theme)) === '["@muten/fakeui/globals.css","@muten/fakeui/themes/noir.css","@muten/fakeui/nova.css"]', JSON.stringify(libraryImports(found, theme)));
ok('its tokens are the custom properties it declares', libraryTokens(found).has('primary') && libraryTokens(found).has('radius'));
const css = withLibraryCss('@import "tailwindcss";\n.x{}', found, theme);
ok('its stylesheets go right after Tailwind', css.indexOf('@import "tailwindcss";') < css.indexOf('@muten/fakeui/globals.css') && css.indexOf('globals.css') < css.indexOf('.x{}'), css);
ok('one the app already imports is not imported twice', (withLibraryCss('@import "@muten/fakeui/globals.css";', found, theme).match(/globals\.css/g) || []).length === 1);
const out = emitTheme(theme, undefined, found.dark);
ok('a token by its own name overrides the library\'s (--primary on :root)', /:root \{[^}]*--primary: #6B46F2/.test(out), out);
ok('dark { } hangs on the library\'s dark selector', out.includes('.dark, [data-theme="dark"] {') && out.includes('--primary: #8B6CF6'), out);
ok('the app\'s own scales still work (--color-brand)', out.includes('--color-brand: #ff0'), out);
const root = themeRoot(found, theme);
ok('<html> gets the class a chosen stylesheet is scoped to, and the dark class for mode dark', JSON.stringify(root) === '{"classes":["style-nova","dark"],"scheme":"dark"}', JSON.stringify(root));
ok('…written into index.html, keeping what is there', withThemeRoot('<html lang="es" class="a">', root) === '<html lang="es" class="a style-nova dark" data-theme="dark">', withThemeRoot('<html lang="es" class="a">', root));
ok('a theme that names a library enables its parts like plugins { }', (writeFileSync(join(app, 'theme.muten'), source), pluginNames(app).includes('fakeui')));

const themeCodes = (text) => checkThemeText(app, text).map((d) => d.code + (d.suggestion ? ':' + d.suggestion : '') + '@' + d.loc?.line);
ok('a clean library theme says nothing', checkThemeText(app, source).length === 0, JSON.stringify(checkThemeText(app, source)));
ok('a misspelled preset, extra and token: each named, at its line', JSON.stringify(themeCodes('theme fakeui {\n  preset nior\n  with nava\n  primry "#fff"\n}')) === '["theme-preset:noir@2","theme-extra:nova@3","theme-unknown-token:primary@4"]', JSON.stringify(themeCodes('theme fakeui {\n  preset nior\n  with nava\n  primry "#fff"\n}')));
ok('a library that is not installed', themeCodes('theme nothere { }')[0]?.startsWith('theme-library-missing'));
ok('a value of the wrong kind', themeCodes('theme {\n  space { md "sixteen" }\n}')[0] === 'theme-value@2');
ok('a word that is no CSS color is not a color; a named one is', themeCodes('theme { colors { a "violeta"  b "rebeccapurple" } }').join() === 'theme-value@1', themeCodes('theme { colors { a "violeta"  b "rebeccapurple" } }').join());
ok('a library token takes the kind of value the library gives it', themeCodes('theme fakeui {\n  primary "violeta"\n  radius "8px"\n}').join() === 'theme-value@2', themeCodes('theme fakeui {\n  primary "violeta"\n  radius "8px"\n}').join());
ok('a font may be a family', checkThemeText(app, 'theme { font { body "\'Inter\', sans-serif" } }').length === 0);
ok('a section close to a known one is a warning', checkThemeText(app, 'theme { spaec { md "1px" } }')[0]?.severity === 'warning');
ok('a syntax error is located', themeCodes('theme { space { md "1px" }')[0]?.startsWith('syntax@'));

const configCodes = (text) => checkConfigText(app, text).map((d) => d.code + (d.suggestion ? ':' + d.suggestion : '') + '@' + d.loc?.line);
ok('an unknown block, at its line, with the right name', configCodes('\nplugns { }')[0] === 'config-block:plugins@2', JSON.stringify(configCodes('\nplugns { }')));
ok('an unknown key', configCodes('security { cps "default" }')[0] === 'config-key:csp@1');
ok('a csp that is no policy', configCodes('security { csp "defualt" }')[0]?.startsWith('config-value:default'));
ok('a plugin that is not installed is a warning', checkConfigText(app, 'plugins { nope { } }')[0]?.severity === 'warning');
ok('an installed plugin is fine', checkConfigText(app, 'plugins { fakeui { } }').length === 0);
ok('a url without quotes says to quote it', checkConfigText(app, 'env { local { api http://x } }')[0]?.message.includes('goes in quotes'));
ok('a block never closed', checkConfigText(app, 'dev {')[0]?.message.includes('never closed'));
rmSync(app, { recursive: true, force: true });

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
