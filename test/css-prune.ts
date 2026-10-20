// css-prune: a rule goes only when every selector of it needs a class the shipped code never contains. The cases that
// would break a page if the test were naive: a class inside :not()/:is(), a class built from a prefix at run time,
// Tailwind's escaped names, rules inside @media, and the at-rules that must never be touched.
import { pruneCss, shippedWords } from '../dist/css-prune.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };
const code = 'el.className = "mu-stack card md:flex w-[3px]"; x.classList.add("is-open"); const k = "status-" + s; const t = `cx-${n}`; document.querySelector(".tab-on")';
const prune = (css) => pruneCss(css, code).css;

ok('a rule for a class the code contains stays', prune('.card{color:red}') === '.card{color:red}');
ok('a rule for a class nobody uses goes', prune('.ghost{color:red}') === '');
ok('only the dead selector of a list goes', prune('.card,.ghost{color:red}') === '.card{color:red}', prune('.card,.ghost{color:red}'));
ok('a class only inside :not() is not needed', prune('.card:not(.ghost){color:red}') === '.card:not(.ghost){color:red}');
ok('a class only inside :is()/:where()/:has() is not needed', prune(':is(.ghost,.card) b{x:1}') === ':is(.ghost,.card) b{x:1}' && prune('.card:has(.ghost){x:1}') === '.card:has(.ghost){x:1}');
ok('a class built from a prefix at run time stays', prune('.status-online{x:1}') === '.status-online{x:1}' && prune('.cx-row{x:1}') === '.cx-row{x:1}');
ok('a class named in a selector string in a script stays', prune('.tab-on{x:1}') === '.tab-on{x:1}');
ok('Tailwind escaped names match their markup spelling', prune('.md\\:flex{display:flex}') === '.md\\:flex{display:flex}' && prune('.w-\\[3px\\]{width:3px}') === '.w-\\[3px\\]{width:3px}');
ok('a dead escaped name goes', prune('.lg\\:grid{display:grid}') === '');
ok('rules inside @media are pruned and an emptied @media goes', prune('@media (min-width:1px){.ghost{x:1}}.card{y:2}') === '.card{y:2}' && prune('@media (min-width:1px){.card{x:1}.ghost{y:2}}') === '@media (min-width:1px){.card{x:1}}');
ok('@font-face, @keyframes and :root are kept as written', prune('@font-face{font-family:a;src:url(x.woff2)}@keyframes spin{to{transform:rotate(1turn)}}:root{--a:1}') === '@font-face{font-family:a;src:url(x.woff2)}@keyframes spin{to{transform:rotate(1turn)}}:root{--a:1}');
ok('element and attribute selectors are never dropped', prune('a[href]{x:1}button{y:2}[data-state=open]{z:3}') === 'a[href]{x:1}button{y:2}[data-state=open]{z:3}');
ok('a brace inside a string does not end the rule', prune('.card::after{content:"}"}.ghost{x:1}') === '.card::after{content:"}"}');
ok('nested rules go with their parent, and stay with it', prune('.card{color:red;&:hover{color:blue}}.ghost{&.x{y:1}}') === '.card{color:red;&:hover{color:blue}}');
// shadcn's own components: Tailwind classes with arbitrary variants carry `=`, `>` and parentheses
const tsx = 'className={cn("peer group/switch inline-flex has-[>svg]:px-3", "group-data-[size=default]/switch:size-4 data-[state=checked]:translate-x-[calc(100%-2px)]")}';
const kept = pruneCss('.group-data-\\[size\\=default\\]\\/switch\\:size-4:is(:where(.group\\/switch)[data-size=default] *){width:1rem}.has-\\[\\>svg\\]\\:px-3:has(>svg){padding:0}.data-\\[state\\=checked\\]\\:translate-x-\\[calc\\(100\\%-2px\\)\\][data-state=checked]{translate:1px}.never-used{color:red}', tsx).css;
ok('a class with an arbitrary variant or value is read whole (shadcn\'s switch kept its thumb size)', kept.includes('size-4') && kept.includes('px-3') && kept.includes('translate-x') && !kept.includes('never-used'), kept);
ok('a one-letter prefix keeps nothing extra', !shippedWords('"a-" + x').prefixes.includes('a-'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
