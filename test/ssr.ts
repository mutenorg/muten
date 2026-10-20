// SSR pre-render: execute a compiled reactive page against the build-time fake DOM (project/ssr.ts) and
// serialize. Data-driven content — each over mock rows, state interpolation, when — must land in the HTML
// (that's the SEO/first-paint win); the same page still ships the runtime for client takeover.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile, compileModule } from '#engine/compile/compile.js';
import { Fmt } from '#engine/shared/vocab.js';
import { renderSsrBody, fetchSources } from '#engine/project/ssr.js';
import { sourceRequest, sourceRows } from '#engine/shared/source.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };
const ssr = (src, data = {}) => renderSsrBody(compile(toDoc(parse(src)), data, '', {}, {}, { format: Fmt.Ssr }));

// each over query mock data → real rows in the HTML
const list = ssr(`screen c
entity Item { name text }
state { items = query items : list<Item> }
Page { each items as it { Text "{it.name}" } }`, { items: [{ name: 'Apple' }, { name: 'Banana' }] });
ok('each renders mock rows', list.includes('Apple') && list.includes('Banana'), list);
ok('rows are real <p> tags', (list.match(/<p class="mu-text">/g) || []).length === 2);

// interpolation resolves the state initial at build
ok('interpolation uses state initial', ssr(`screen c\nstate { name = "World" : text }\nPage { Title "Hi {name}" }`).includes('Hi World'));

// when true → body present; when false → body absent
ok('when true renders body', ssr(`screen c\nstate { on = true : bool }\nPage { when on { Text "yes" } }`).includes('yes'));
ok('when false omits body', !ssr(`screen c\nstate { on = false : bool }\nPage { when on { Text "no" } }`).includes('no'));

// containers + class() pass straight through to the mu- base class
ok('containers + classes', ssr(`screen c\nPage class("p-6") { Title "T" }`).includes('<main class="mu-page p-6"'));

// HTML is escaped (no injection from data)
ok('text is escaped', ssr(`screen c\nstate { x = "<b>hi</b>" : text }\nPage { Text "{x}" }`).includes('&lt;b&gt;'));

// a source descriptor → a complete request (the single definition the build and runtime share)
ok('bare URL → GET request', JSON.stringify(sourceRequest('http://x')) === '{"url":"http://x","method":"GET","headers":{},"body":null,"at":null,"wait":false,"credentials":""}');
ok('`wait: true` is carried', sourceRequest({ url: '/pro', wait: true }).wait === true && sourceRequest({ url: '/pro' }).wait === false);
const req = sourceRequest({ url: 'http://x', method: 'post', headers: { Authorization: 'Bearer t' }, body: { a: 1 }, at: 'data' });
ok('full request: method/headers/body/at', req.method === 'POST' && req.headers.Authorization === 'Bearer t' && req.body === '{"a":1}' && req.at === 'data');
ok('sourceRows picks json[at]', JSON.stringify(sourceRows({ data: [{ x: 1 }] }, 'data')) === '[{"x":1}]');
ok('sourceRows walks dotted at', JSON.stringify(sourceRows({ data: { posts: [{ x: 1 }] } }, 'data.posts')) === '[{"x":1}]');

// app-wide `api` config: base URL + default headers, applied to every source (no repeating per source)
const apiCfg = { base: 'https://api.x.com/v1', headers: { Authorization: 'Bearer K', Accept: 'json' } };
ok('relative url joined to base', sourceRequest('/posts', apiCfg).url === 'https://api.x.com/v1/posts');
ok('absolute url ignores base', sourceRequest('https://other.com/p', apiCfg).url === 'https://other.com/p');
ok('slash seam collapsed', sourceRequest({ url: '/posts' }, { base: 'https://api.x.com/v1/' }).url === 'https://api.x.com/v1/posts');
ok('api headers inherited', sourceRequest('/posts', apiCfg).headers.Authorization === 'Bearer K');
ok('source header overrides api', sourceRequest({ url: '/p', headers: { Accept: 'xml' } }, apiCfg).headers.Accept === 'xml');
ok('no api → url unchanged', sourceRequest('https://x.com/p').url === 'https://x.com/p');

// named clients: many backends in one `api` map, a source picks with `{ api: "name" }`
const multi = { shop: { base: 'https://shop.com/v1', headers: { Authorization: 'Bearer S' } }, cms: { base: 'https://cms.io' } };
ok('named client: shop', sourceRequest({ api: 'shop', url: '/products' }, multi).url === 'https://shop.com/v1/products');
ok('named client: cms', sourceRequest({ api: 'cms', url: '/posts' }, multi).url === 'https://cms.io/posts');
ok('named client headers', sourceRequest({ api: 'shop', url: '/x' }, multi).headers.Authorization === 'Bearer S');
ok('default client used when unnamed', sourceRequest({ url: '/x' }, { default: { base: 'https://d.com' } }).url === 'https://d.com/x');
ok('flat form still works', sourceRequest('/x', { base: 'https://flat.com' }).url === 'https://flat.com/x');

// meta/head: title + description in the <head> (static), og:* auto-derived (one source), module export (reactive)
const metaHtml = compile(toDoc(parse('screen a\nmeta { title "T" description "D" }\nPage { Title "x" }')));
ok('meta title in <head>', metaHtml.includes('<title>T</title>'));
ok('meta description tag', metaHtml.includes('<meta name="description" content="D">'));
ok('og:* auto-derived from title/description', metaHtml.includes('property="og:title" content="T"') && metaHtml.includes('property="og:description" content="D"'));
ok('reactive page exports meta (for the router)', compileModule(toDoc(parse('screen a\nmeta { title "T" }\nstate { n = 0 : number }\nPage { Title "{n}" }'))).includes('export const meta = {"title":"T"'));

// real-path navigation: Links emit a real path (no #), so the history router / MPA navigation works
ok('Link emits a real path (no #)', compile(toDoc(parse('screen a\nPage { Link "About" -> "/about" }'))).includes('href="/about"'));
{ const js = compileModule(toDoc(parse('screen a\nstate { n = 0 : number }\nPage { Link "x" -> "/about"  Text "{n}" }'))); ok('reactive Link real path (no #)', js.includes('.href = "/about"') || js.includes('href=\\"/about\\"')); } // built or cloned from a template

// remote sources fetched at build (stubbed fetch): GET runs, non-GET is skipped (no side effects), offline → skip
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => ({ json: async () => String(url).includes('nested') ? { items: [{ x: 1 }] } : [{ x: 2 }, { x: 3 }] });
ok('bare-URL source → array', JSON.stringify((await fetchSources({ a: 'http://x/list' })).a) === '[{"x":2},{"x":3}]');
ok('{url,at} source → json[at]', JSON.stringify((await fetchSources({ b: { url: 'http://x/nested', at: 'items' } })).b) === '[{"x":1}]');
ok('non-GET source NOT fetched at build', !('w' in await fetchSources({ w: { url: 'http://x', method: 'POST' } })));
globalThis.fetch = async () => { throw new Error('offline'); };
ok('offline fetch → skipped (no crash)', !('c' in await fetchSources({ c: 'http://x' })));
globalThis.fetch = realFetch;

// style() IS PART OF THE PAGE: a bar's width or a card's color lives in a CSS variable, and the static build used to
// drop it (every bar at its default). It lands as a style attribute now, interpolated from the initial state.
{
  const bar = ssr('screen c\nstate { pct = 40 : number }\nPage { Stack class("bar") style(w: "{pct}%", tone: "red") { Text "x" } }');
  ok('style() vars land in the static HTML', /style="--w:40%;--tone:red"/.test(bar), bar);
  ok('a quote in a style value is escaped', ssr('screen c\nstate { v = "a\\"b" : text }\nPage { Stack style(x: "{v}") { Text "x" } }').includes('&quot;'));
}

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
