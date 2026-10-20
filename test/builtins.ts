// The text/number built-ins that replace the small .ts helpers apps kept writing (slugify, digitsIn, splitIds,
// pesos, copyText, paramInUrl…): what each returns, including for an absent value (a field not loaded yet).
import { BUILTINS_JS } from '#engine/compile/emit.js';
import { BUILTINS, BUILTIN_DOCS } from '#engine/lang/manifest.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const fns = new Function(`${BUILTINS_JS}\nreturn { ago, calendar, money, fixed, percent, pad, num, trim, digits, slugify, replace, startsWith, endsWith, split, joined, urlParam };`)();
const same = (label, got, want) => ok(`${label} → ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

same('money(1234, "USD", "en-US") has no decimals when whole', fns.money(1234, 'USD', 'en-US'), '$1,234');
same('money(1234.5, "USD", "en-US")', fns.money(1234.5, 'USD', 'en-US'), '$1,234.50');
same('money(1234.5, "", "es-CO") is the number alone', fns.money(1234.5, '', 'es-CO'), '1.234,5');
same('money of nothing', fns.money(null, 'USD', 'en-US'), '$0');
same('fixed(4.5, 2, "en-US")', fns.fixed(4.5, 2, 'en-US'), '4.50');
same('percent(0.25)', fns.percent(0.25).replace(/\s/g, ''), '25%');
same('pad(5, 2)', fns.pad(5, 2), '05');
same('num("4,5")', fns.num('4,5'), 4.5);
same('num("abc")', fns.num('abc'), 0);
same('trim("  a ")', fns.trim('  a '), 'a');
same('digits("+57 300-123")', fns.digits('+57 300-123'), '57300123');
same('slugify("Café  Luz!")', fns.slugify('Café  Luz!'), 'cafe-luz');
same('replace is literal, every one', fns.replace('a.b.c', '.', '-'), 'a-b-c');
same('startsWith', fns.startsWith('https://x', 'https:'), true);
same('endsWith of nothing', fns.endsWith(undefined, 'x'), false);
same('split trims and drops empties', fns.split(' a, b,,c '), ['a', 'b', 'c']);
same('split with a separator', fns.split('a|b', '|'), ['a', 'b']);
same('joined', fns.joined(['a', 'b'], ' · '), 'a · b');
same('joined of nothing', fns.joined(null), '');
same('urlParam without a page', fns.urlParam('ref'), '');

// dates speak the reader's language now (they were fixed English: «5m ago», «Today at»)
const minutesAgo = new Date(Date.now() - 5 * 60000).toISOString();
same('ago in Spanish', fns.ago(minutesAgo, 'es'), 'hace 5 minutos');
same('ago in English', fns.ago(minutesAgo, 'en'), '5 minutes ago');
same('ago of a moment ago', fns.ago(new Date().toISOString(), 'es'), 'ahora');
same('ago of a future time', fns.ago(new Date(Date.now() + 3 * 86400000 + 60000).toISOString(), 'en'), 'in 3 days');
ok('calendar today in Spanish starts with «Hoy, »', fns.calendar(new Date().toISOString(), 'es').startsWith('Hoy, '), fns.calendar(new Date().toISOString(), 'es'));
ok('calendar yesterday in English starts with «Yesterday, »', fns.calendar(new Date(Date.now() - 86400000).toISOString(), 'en').startsWith('Yesterday, '), fns.calendar(new Date(Date.now() - 86400000).toISOString(), 'en'));
same('ago of a non-date passes it through', fns.ago('soon'), 'soon');

const undocumented = BUILTINS.filter((name) => !BUILTIN_DOCS[name]);
ok('every built-in is documented (autocomplete, the AI reference)', undocumented.length === 0, undocumented.join(', '));
const missing = BUILTINS.filter((name) => !new RegExp(`function ${name}\\(`).test(BUILTINS_JS));
ok('every built-in has its source', missing.length === 0, missing.join(', '));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
