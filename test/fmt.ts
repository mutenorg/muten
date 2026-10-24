// `muten fmt`: only whitespace moves, and what was laid out by hand stays. Each case is one met in Storio's own files.
import { format } from '../dist/fmt.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const messy = 'screen home\n\n\n\nstate { n = 0 : number }   \nPage {\n      Title "Hola"   # a comment, kept\n  Stack {\nText "x"\n        }\n}';
const shaped = format(messy);
ok('each line two spaces per open brace, no trailing spaces, one blank line, one final newline', shaped === 'screen home\n\nstate { n = 0 : number }\nPage {\n  Title "Hola"   # a comment, kept\n  Stack {\n    Text "x"\n  }\n}\n', JSON.stringify(shaped));
ok('formatting twice changes nothing', format(shaped) === shaped);
const two = 'Page {\n  when on { Group(label: "a") {\n    Text "b"\n  } }\n}\n';
ok('two braces opened on one line are one level (closed by `} }`)', format(two) === two, JSON.stringify(format(two)));
const aligned = 'entity Shop { id text  slug text\n              name text  city text }\nPage {\n  Text "x"\n}\n';
ok('a block whose fields start on its own line keeps the alignment written by hand', format(aligned) === aligned, JSON.stringify(format(aligned)));
const header = 'action edit(row: text)\n       mutates a, b {\n  a.set(row)\n}\nPage {\n  Text "x"\n}\n';
ok('`mutates` under its action stays where it was put', format(header) === header, JSON.stringify(format(header)));
const fn = 'fn f(x: number): number {\n      const y = { a: 1 }\n  return x + y.a\n}\nPage {\n  Text "{f(1)}"\n}\n';
ok('a fn\'s TypeScript body is not touched', format(fn) === fn, JSON.stringify(format(fn)));
const args = 'Page {\n  Box(a: 1,\n      b: 2)\n}\n';
ok('an argument list laid out over lines stays', format(args) === args, JSON.stringify(format(args)));
ok('a file that does not read is left as it is', format('Page { "') === 'Page { "');
console.log(f ? `\n✗ ${f} failed` : '\nALL OK');
process.exit(f ? 1 : 0);
