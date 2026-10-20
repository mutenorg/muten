// use-bundle: `muten build` pages get their `use` functions (they used to be left out: «t is not defined»).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleUses, customSource, bundleCustoms } from '../dist/use-bundle.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const root = mkdtempSync(join(tmpdir(), 'muten-use-'));
mkdirSync(join(root, 'src/lib'), { recursive: true });
mkdirSync(join(root, 'src/pages/p'), { recursive: true });
writeFileSync(join(root, 'src/lib/t.ts'), 'export function t(key: string): string { return "[" + key + "]"; }\nexport const unused = 1;\n');
const code = await bundleUses([{ names: ['t'], from: '~/lib/t.ts' }], join(root, 'src/pages/p/p.muten'), root);
ok('the use functions come back as constants in scope', /const \{ t \} = __muten_use;$/.test(code), code.slice(-80));
ok('`~/` resolves to src/', new Function(`${code}\nreturn t("a.b");`)() === '[a.b]');
ok('a page without use gets nothing', (await bundleUses([], join(root, 'src/pages/p/p.muten'), root)) === '');
// a Custom with imports of its own travels as a module (CUSTOM_MODULE + path); one without is inlined as always
mkdirSync(join(root, 'src/components'), { recursive: true });
writeFileSync(join(root, 'src/components/Loud.js'), "import { t } from '~/lib/t.ts';\nexport function mount(el) { el.textContent = t('x'); }\n");
writeFileSync(join(root, 'src/components/Plain.js'), "function mount(el) { el.textContent = 'p'; }\n");
const loud = customSource(join(root, 'src/components/Loud.js'));
ok('a Custom with imports is a module', loud.startsWith('\u0000module:') && loud.endsWith('Loud.js'));
ok('a Custom without imports is its source', customSource(join(root, 'src/components/Plain.js')).startsWith('function mount'));
const customs = await bundleCustoms({ Loud: loud }, root);
ok('bundled, its mount is __custom_Loud', /const __custom_Loud = __muten_custom\.Loud;$/.test(customs) && typeof new Function(`${customs}\nreturn __custom_Loud;`)() === 'function');
rmSync(root, { recursive: true, force: true });

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
