// Parser contract: a small but representative .screen maps to the expected IR shape.
// Self-contained (no playground page) so it stays green as host apps come and go.
import { parse } from '../engine/parse.js';

const src = `
screen demo

entity Character { name text  status text  image text }

state {
  q = "" : text
  characters = query listCharacters : list<Character>
}

sources {
  listCharacters: { url: "https://rickandmortyapi.com/api/character", at: "results" }
}

Page {
  when characters.loading { Text "Loading…" }
  Stack style(grid, gap.md) {
    each characters as c {
      Image "{c.image}"
      Text "{c.name}"
    }
  }
}
`;

const ir = parse(src);
let pass = 0, fail = 0;
const ok = (name, cond) => { (cond ? (pass++, console.log('✓ ' + name)) : (fail++, console.log('✗ ' + name))); };

ok('screen name parsed', ir.screen === 'demo');
ok('entity has implicit uuid id', ir.entities.Character.id === 'uuid');
ok('text state initial is ""', ir.state.q.initial === '');
ok('query state carries source', String(ir.state.characters.source).startsWith('query:'));

// sources block
ok('sources parsed', !!ir.sources && !!ir.sources.listCharacters);
ok('source url is the real API', ir.sources.listCharacters.url === 'https://rickandmortyapi.com/api/character');
ok('source `at` extracts results', ir.sources.listCharacters.at === 'results');

// find nodes in the tree
const flat = [];
(function walk(n) { if (!n) return; flat.push(n); for (const c of n.children || []) walk(c); })(ir.tree);
const byType = (t) => flat.filter((n) => n.type === t);

ok('when node parsed', byType('When').length === 1);
ok('each node binds item var', byType('Each')[0]?.props?.as === 'c');
ok('Image is a node', byType('Image').length === 1);

// Image src interpolates (like Text), referencing the item var
const img = byType('Image')[0];
ok('Image src is an interpolation', img?.props?.src?.kind === 'interp');
ok('Image interp carries the c.image ref', JSON.stringify(img?.props?.src).includes('c.image'));

console.log(`\n${fail ? '✗ ' + fail + ' FAILED' : 'ALL OK'} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
