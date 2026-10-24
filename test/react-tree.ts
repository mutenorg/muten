// React-only UI libraries composed from .muten the way their docs compose them. The React lab outside the repo runs
// lucide, Sonner, react-day-picker, Recharts, Radix, MUI, Mantine, cmdk, Motion and Vaul in Chrome; this pins the
// compiler's side: what parses, what each node becomes, and what check says.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { validate } from '#engine/ir/validate.js';
import { print } from '#engine/ir/print.js';
import { compileModule } from '#engine/compile/compile.js';

let f = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? '✓' : '✗') + ' ' + label + (cond ? '' : '   ← ' + extra)); if (!cond) f++; };
const page = (body) => toDoc(parse(`screen p\n${body}`));
const codes = (body) => validate(page(body), {}).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);   // errors: `use react` is written on purpose here, its use-react-redundant warning is expected
const js = (body) => compileModule(page(body), {}, '', {}, {}, {});

const chart = 'use react LineChart, Line, XAxis from "recharts"\nstate { sales = [ { day: "lun", total: 1 } ] : list }\nPage { LineChart(width: 400, height: 200, data: sales) { XAxis(dataKey: "day") Line(dataKey: "total") } }';
ok('several components from one library, composed', codes(chart).length === 0, codes(chart).join());
const chartJs = js(chart);
// (the namespace is loaded when the island wakes: runtime-island.ts, react-tree.ts reactLoader)
ok('one namespace per library, each part picked by name', /__react_ns_LineChart = __l0;/.test(chartJs) && (chartJs.match(/import\("recharts"\)/g) || []).length === 1 && chartJs.includes('__react_pick(__react_ns_LineChart, "XAxis", [])'), chartJs.match(/const __react_load[^\n]*/)?.[0]);
ok('children are React children of their component, in one island', /__root\.render\(__react_h\(__react_pick\(__react_ns_LineChart, "LineChart", \[\]\), \{[^}]*"data": sales\.get\(\)[^}]*\}, __react_h\(__react_pick\(__react_ns_LineChart, "XAxis"/.test(chartJs), chartJs.match(/__root\.render\([^\n]*/)?.[0]);

const dialog = 'use react Dialog from "@radix-ui/react-dialog"\nstate { n = 0 : number }\naction more() mutates n { n.set(n + 1) }\nPage { Dialog.Root { Dialog.Trigger { Text "Abrir" } Dialog.Content { Text "Van {n}" Button "Sumar" -> more } } }';
ok('a namespaced part needs no parentheses (Dialog.Root { … })', codes(dialog).length === 0, codes(dialog).join());
const dialogJs = js(dialog);
ok('a dotted part is picked through its namespace', dialogJs.includes('__react_pick(__react_ns_Dialog, "Dialog", ["Root"])'));
ok('a plain Text is the text it holds, live', dialogJs.includes('("Van " + String(n.get() ?? \'\'))'), dialogJs.match(/__root\.render\([^\n]*/)?.[0]);
ok('a muten node inside is built by muten and mounted in a slot', /const el_\w+_slot = document\.createElement\('span'\)/.test(dialogJs) && dialogJs.includes('__react_h(__MutenSlot, { node: el_'));
ok('print keeps a dotted part', print(parse(`screen p\n${dialog}`)).includes('Dialog.Root'));

const palette = 'use react Command from "cmdk"\nentity Item { name text }\nstate { items = [] : list<Item> }\nPage { Command { Command.List { each items as it { Command.Item(value: it.name) { Text "{it.name}" } } } } }';
ok('a list inside a React component is a map of React children, keyed by row', codes(palette).length === 0 && js(palette).includes('...(items.get() || []).flatMap((it, __i) => [__react_h(__react_pick(__react_ns_Command, "Command", ["Item"]), { "value": it.name, "key": (it && it.id != null ? it.id : __i) + '), codes(palette).join() + js(palette).match(/flatMap[^\n]{0,200}/)?.[0]);
ok('a muten node in such a row is named, not shown in one row only', codes(palette.replace('Text "{it.name}"', 'Span "{it.name}"')).includes('react-list-node'));

const anim = 'use react motion from "motion/react"\nstate { shown = true : bool }\nPage { motion.div(initial: { opacity: 0 }, animate: { opacity: shown ? 1 : 0 }) { Text "Hola" } }';
ok('an object prop, live', codes(anim).length === 0 && js(anim).includes('"animate": { "opacity": (shown.get() ? 1 : 0) }'), js(anim).match(/"animate"[^}]*\}/)?.[0]);
ok('an object prop reads only what exists', codes(anim.replace('shown ? 1', 'shwon ? 1')).length > 0);
ok('print keeps an object prop', print(parse(`screen p\n${anim}`)).includes('animate: { opacity: shown ? 1 : 0 }'));

const mui = 'use react Button from "@mui/material"\nstate { n = 0 : number }\naction more() mutates n { n.set(n + 1) }\nPage { Button(variant: "contained") on(click: more) class("cta") { Text "Sumar" } }';
ok('a library component may take a primitive\'s name in its file (MUI Button)', codes(mui).length === 0, codes(mui).join());
ok('class() is its className, on(click) its onClick', js(mui).includes('"onClick": (...__a) => more(...__a)') && js(mui).includes('"className": "cta"'));
ok('every page with React carries the picker and the slot once', (js(mui).match(/function __react_pick/g) || []).length === 1);

// ── theme.muten, read by a library's provider ──
const themeValues = { colors: { primary: '#6B46F2' }, radius: { md: '12px' }, tokens: { ring: '#000' } };
const themed = toDoc(parse('screen p\nuse createTheme from "@mui/material"\nget look = createTheme({ palette: { primary: { main: theme.colors.primary } }, shape: { borderRadius: theme.radius.md } })\nPage { Text "{theme.ring}" }'));
ok('theme.colors.primary, theme.radius.md and a library token are known', validate(themed, { themeValues }).diagnostics.length === 0, JSON.stringify(validate(themed, { themeValues }).diagnostics));
const themedJs = compileModule(themed, {}, '', {}, {}, { themeValues });
ok('they are the values theme.muten has, fixed at build', themedJs.includes('"main": "#6B46F2"') && themedJs.includes('"borderRadius": "12px"'), themedJs.match(/createTheme\([^\n]*/)?.[0]);
const typo = validate(toDoc(parse('screen p\nPage { Text "{theme.colors.primry}" }')), { themeValues }).diagnostics.find((d) => d.code === 'theme-ref');
ok('a name theme.muten does not have, with the closest', typo?.suggestion === 'primary', JSON.stringify(typo));
ok('a page state named theme keeps its name', validate(toDoc(parse('screen p\nstate { theme = "dark" : text }\nPage { Text "{theme}" }')), { themeValues }).diagnostics.length === 0);

// ── props are expressions; a package's values are names ──
const chakra = 'use react Button from "@chakra-ui/react"\nuse createSystem, defaultConfig from "@chakra-ui/react"\nget system = createSystem(defaultConfig, {})\nstate { on = true : bool }\nPage { Button(bg: on ? "brand" : "gray.300") { Text "Ir" } }';
ok('a prop may be any expression, and a package value a plain name', codes(chakra).length === 0 && js(chakra).includes('"bg": (on.get() ? "brand" : "gray.300")') && js(chakra).includes('createSystem(defaultConfig, {  })'), codes(chakra).join() + js(chakra).match(/"bg"[^,]*/)?.[0] + js(chakra).match(/createSystem\([^)]*\)/)?.[0]);

// ── theme.muten's providers: declared once, around every component of their library ──
const kitIr = parse('use createTheme from "@mui/material"\ntheme { colors { primary "#6B46F2" } }\nprovider ThemeProvider(theme: createTheme({ palette: { primary: { main: theme.colors.primary } } })) from "@mui/material"');
const themeKit = { values: kitIr.theme, providers: kitIr.providers, imports: kitIr.imports };
ok('theme.muten parses a provider with its library and props', kitIr.providers?.[0]?.component === 'ThemeProvider' && kitIr.providers[0].from === '@mui/material');
const wrapped = compileModule(page('use react Button from "@mui/material"\nPage { Button(variant: "contained") { Text "Ir" } }'), {}, '', {}, {}, { themeKit });
ok('a page using the library is wrapped, with what the provider calls imported', wrapped.includes('__react_pick(__react_ns_Button, "ThemeProvider", [])') && wrapped.includes('const createTheme = __pkg_') && wrapped.includes('createTheme({ "palette": { "primary": { "main": "#6B46F2" } } })'), wrapped.match(/__provided[^\n]*/)?.[0]);
const other = compileModule(page('use react Badge from "@mantine/core"\nPage { Badge { Text "x" } }'), {}, '', {}, {}, { themeKit });
ok('a page of another library is left as it is', !other.includes('ThemeProvider') && !other.includes('createTheme'));

ok('an island\'s own box is out of the layout: the component sits in its parent\'s flex or grid', /el_\w+\.style\.display = 'contents';/.test(chartJs));
// a library inside another one's component: the island gets both providers (a MUI card in a Chakra layout keeps MUI's theme)
const twoIr = parse('use createTheme from "@mui/material"\nuse createSystem, defaultConfig from "@chakra-ui/react"\ntheme { colors { primary "#6B46F2" } }\nprovider ThemeProvider(theme: createTheme({ palette: { primary: { main: theme.colors.primary } } })) from "@mui/material"\nprovider ChakraProvider(value: createSystem(defaultConfig, {})) from "@chakra-ui/react"');
const twoKit = { values: twoIr.theme, providers: twoIr.providers, imports: twoIr.imports };
const mixed = compileModule(page('use react Box from "@chakra-ui/react"\nuse react Button from "@mui/material"\nPage { Box(p: "4") { Button(variant: "contained") { Text "Ir" } } }'), {}, '', {}, {}, { themeKit: twoKit });
ok('a MUI component inside a Chakra one gets MUI\'s provider too', mixed.includes('__react_pick(__react_ns_Button, "ThemeProvider", [])') && mixed.includes('__react_pick(__react_ns_Box, "ChakraProvider", [])'), mixed.match(/__root\.render[^\n]{0,240}/)?.[0]);
const shadcnPage = 'use react Card from "@/components/ui/card"\nPage { Card class("w-[380px]") { Text "x" } }';
ok('a component followed straight by class(…) is the component, not a primitive of the same name', codes(shadcnPage).length === 0 && js(shadcnPage).includes('"className": "w-[380px]"'), codes(shadcnPage).join());

if (f) { console.log(`\n✗ ${f} failed`); process.exit(1); }
console.log('\n✓ react-tree: all passed');
