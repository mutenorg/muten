// muten.config parser: generic value shapes + the styling block -> ThemeAdapter mapping.
import { parseConfig, configThemeAdapter } from '#engine/project/config.js';

let fails = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? '✓' : 'x'} ${label}${ok ? '' : '   ← ' + extra}`);
  if (!ok) fails++;
};

// generic values: string, number, bool, bare ident, list, nested block
{
  const c = parseConfig('dev { port 5402  open false  host "localhost"  tags [a, "b"]  nest { deep 1 } }');
  check('number', c.dev.port === 5402);
  check('bool', c.dev.open === false);
  check('string', c.dev.host === 'localhost');
  check('list', Array.isArray(c.dev.tags) && c.dev.tags.length === 2);
  check('nested block', typeof c.dev.nest === 'object');
}

// styling block -> ThemeAdapter: selector wrapped with `{`/`}`, sections carried through
{
  const src = `styling {
    prefix { colors "--color-" }
    blocks {
      base  { selector "@theme"               sections [colors, dark] }
      light { selector "[data-theme='light']" sections [light] }
    }
  }`;
  const a = configThemeAdapter(parseConfig(src))!;
  check('prefix', a.prefix.colors === '--color-');
  check('open adds brace', a.blocks[0].open === '@theme {');
  check('close is }', a.blocks[0].close === '}');
  check('sections', a.blocks[0].sections.join(',') === 'colors,dark');
  check('attr selector kept', a.blocks[1].open === "[data-theme='light'] {");
}

// no styling block -> undefined (zero-config)
check('no styling -> undefined', configThemeAdapter(parseConfig('build { out "dist" }')) === undefined);

// bad syntax throws a muten.config error
try { parseConfig('dev { port }'); check('bad syntax throws', false); }
catch (e) { check('bad syntax throws', String(e).includes('muten.config')); }

console.log(fails ? `\n${fails} FAIL` : '\nALL OK');
process.exit(fails ? 1 : 0);
