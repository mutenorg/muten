// Round-trip: parse → print → parse must yield the SAME IR (modulo source locations). This is the
// guarantee that lets an AI mutate the IR by id and re-emit faithful source. See engine/ir/print.ts.
import { parse } from '#engine/lang/parse.js';
import { print } from '#engine/ir/print.js';

let f = 0;
const ok = (l: string, c: boolean, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '  ← ' + e)); if (!c) f++; };
// canonicalize: drop `loc`, sort object keys (a props bag is order-independent) — array order is kept.
function norm(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(norm);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o as object).sort()) if (k !== 'loc') out[k] = norm((o as Record<string, unknown>)[k]);
    return out;
  }
  return o;
}

function roundtrips(label: string, src: string) {
  const ir1 = parse(src);
  let src2 = '', ir2: unknown;
  try { src2 = print(ir1); ir2 = parse(src2); } catch (e) { ok(label, false, 'threw: ' + (e as Error).message + '\n--- printed ---\n' + src2); return; }
  const a = JSON.stringify(norm(ir1)), b = JSON.stringify(norm(ir2));
  ok(label, a === b, 'IR differs\n--- printed ---\n' + src2 + '\n--- a ---\n' + a + '\n--- b ---\n' + b);
}

roundtrips('page: catalog', `screen products
meta { title "Products" }
entity Product { id text  title text  price text }
state { products = query products : list<Product> }
sources { products: "/products" }
Page class("p-6 gap-4") {
  Title "Products" class("text-2xl font-bold")
  when products.loading { Text "Loading" class("opacity-60") }
  each products as p {
    Stack class("gap-2 p-4 rounded-lg shadow") {
      Link "{p.title}" -> "/product/{p.id}" class("font-semibold")
      Button "Add" -> cart.add(p.id) class("px-3 py-1")
    }
  }
}`);

roundtrips('store: cart', `state { items = [] : list<text> }
get count = items.length
action add mutates items <- id { items.push(id) }`);

roundtrips('part: ProductCard', `entity Product { id text  title text }
part ProductCard(product: Product, onAdd: action) {
  Stack class("card") {
    Link "{$product.title}" -> "/product/{$product.id}"
    Button "Add" -> $onAdd($product.id)
  }
}`);

roundtrips('app: shell+routes', `api {
  base: "https://x.com"
}
shell {
  Header class("flex flex-row justify-between") {
    Link "Shop" -> "/"
    Span "Cart {cart.count}"
  }
  slot
}
routes {
  "/" -> products
  "/product/:id" -> product
}`);

// primitives whose positional value isn't `value`: Icon's `name`, Image's `src`+`alt`, Custom's bare-ident
// `component` (a missing case here once let print silently DROP Icon names + Custom names — file-corrupting).
roundtrips('primitives: icon+image+custom', `screen s
Page {
  Icon "lucide:home" class("text-base")
  Image "/logo.svg" alt("the logo") class("w-8")
  Custom FrameworkCompare class("mt-4") {
    Link -> "/" class("x") { Icon "lucide:arrow-left"  Span "Home" }
  }
}`);

roundtrips('exprs+control', `screen s
state { open = false : bool }
action toggle mutates open <- x { open.set(not open) }
Page {
  Stack class(panel, active when open) on(mouseenter: toggle) { Text "menu" }
  Button "x" -> toggle
}`);

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
