// Interactivity: reactive `class(name when cond)` → a classList.toggle effect; `on(event: action)` on any
// element → addEventListener. Static classes stay in the className; conditionals are toggled at runtime.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compileModule } from '#engine/compile/compile.js';

let f = 0;
const ok = (l, c, e = '') => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '   ← ' + e)); if (!c) f++; };

const js = compileModule(toDoc(parse(`screen s
state { open = false : bool }
action toggle mutates open <- x { open.set(not open) }
Page {
  Stack class(panel, active when open) on(mouseenter: toggle) { Text "menu" }
  Button "x" -> toggle
}`)));
ok('static class stays in className', js.includes('"stack panel"'));
ok('reactive class → classList.toggle effect', js.includes('.classList.toggle("active", !!(open.get()))'));
ok('on(event: action) → addEventListener', js.includes('.addEventListener("mouseenter", () => toggle())'));

// a conditional class inside `each` resolves against the item local
const eachJs = compileModule(toDoc(parse(`screen s
entity T { label text  done bool }
state { items = query items : list<T> }
sources { items: { url: "/x" } }
Page { each items as it { Text "{it.label}" class(done when it.done) } }`)));
ok('conditional class in each uses the item', eachJs.includes('.classList.toggle("done", !!(it.done))'));

// dynamic navigation: `-> /product/{p.id}` → an interpolated href (reuses the Text interpolation machinery)
const navJs = compileModule(toDoc(parse(`screen s
entity P { id text  title text }
state { items = query items : list<P> }
sources { items: { url: "/x" } }
Page { each items as p { Link "{p.title}" -> /product/{p.id} } }`)));
ok('dynamic link → interpolated href', navJs.includes(`"/product/" + String(p.id ?? '')`));

// a static path on a dynamic page stays a plain string href (no regression in the JS path)
const staticJs = compileModule(toDoc(parse(`screen s
state { open = false : bool }
action t mutates open <- x { open.set(not open) }
Page { Link "Home" -> /about  Button "x" -> t }`)));
ok('static link → plain href', staticJs.includes('.href = "/about"'));

console.log(f ? `\n${f} FAILURE(S)` : '\nALL OK');
process.exit(f ? 1 : 0);
