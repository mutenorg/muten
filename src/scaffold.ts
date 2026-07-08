// `muten new <page|store|app> <name...>` — scaffold app STRUCTURE (the routes entry, route lines, page + store
// skeletons) so an agent (or a person) fills in CONTENT instead of hand-writing boilerplate. Every skeleton COMPILES,
// so the app is valid — and never entry-less — the moment it's scaffolded. Idempotent: an existing file is left as-is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const titleOf = (s: string): string => cap(s.replace(/[-_/]+/g, ' ').trim()) || 'Page';
// Does this app declare the shadcn plugin? If so, `muten new` seeds a shadcn-flavored skeleton (semantic tokens + a hint to
// use the parts) so the app starts, and stays, in the shadcn idiom. Core stays library-agnostic — a plain app gets a plain stub.
const usesShadcn = (root: string): boolean => { try { return /plugins\s*\{[\s\S]*?\bshadcn\b/.test(readFileSync(join(root, 'muten.config'), 'utf8')); } catch { return false; } };
// a route → its page (folder) name: "/" → home, "/dms" → dms, "/product/:id" → product (params drop out of the name).
const pageName = (route: string): string => route.replace(/^\//, '').replace(/\/:?\w*/g, (m) => (m.startsWith('/:') ? '' : m.replace('/', '-'))).replace(/^:|:/g, '').replace(/-+$/,'') || 'home';

export function ensureApp(root: string): string {
  const f = join(root, 'src', 'app.muten');
  if (!existsSync(f)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, 'routes {\n}\n'); }
  return f;
}

// Insert a `"route" -> page` line into app.muten's routes block (idempotent — skips if the page is already routed).
function addRoute(root: string, route: string, page: string): void {
  const f = ensureApp(root);
  let src = readFileSync(f, 'utf8');
  if (new RegExp(`->\\s*${page}\\b`).test(src)) return;
  const line = `  "${route}" -> ${page}`;
  if (/routes\s*\{[\s\S]*?\n\}/.test(src)) src = src.replace(/(routes\s*\{[\s\S]*?)\n\}/, `$1\n${line}\n}`);
  else src = `routes {\n${line}\n}\n${src}`;
  writeFileSync(f, src);
}

export function newPage(root: string, route: string): string {
  const r = route === 'home' ? '/' : route.startsWith('/') ? route : '/' + route;
  const name = pageName(r);
  const dir = join(root, 'src', 'pages', name);
  const f = join(dir, name + '.muten');
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true });
    const params = [...r.matchAll(/:(\w+)/g)].map((m) => `param ${m[1]}`).join('\n');
    const head = `screen ${name}\n${params ? params + '\n' : ''}`;
    // shadcn app → seed the shadcn idiom (semantic tokens + a hint to use the parts); plain app → a minimal stub. Both COMPILE
    // (only core primitives + class strings) and carry the `# TODO` the completeness gate looks for.
    const body = usesShadcn(root)
      ? `# TODO: replace this stub — build the real ${titleOf(name)} page in the shadcn idiom (parts: Card/Badge/Avatar/Tabs/Combobox; tokens: bg-card, text-muted-foreground, border-border, bg-primary)\nPage class("min-h-screen bg-background text-foreground") {\n  Stack class("mx-auto max-w-5xl flex flex-col gap-6 p-6") {\n    Title "${titleOf(name)}" h1 class("text-3xl font-semibold tracking-tight")\n  }\n}\n`
      : `Page class("p-6") {\n  Title "${titleOf(name)}" h1\n  # TODO: replace this stub with the real page content\n}\n`;
    writeFileSync(f, head + body);
  }
  addRoute(root, r, name);
  return f;
}

export function newStore(root: string, name: string): string {
  const Entity = cap(name.replace(/s$/, '')) || cap(name);   // servers → Server
  const f = join(root, 'src', name + '.store');
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `# TODO: replace with the real entity fields + seed rows\nentity ${Entity} {\n  name text required\n}\n\nstate {\n  items = [ ] : list<${Entity}>\n}\n`);
  }
  return f;
}

export function scaffoldNew(root: string, kind: string, names: string[]): string[] {
  if (kind === 'app') return [ensureApp(root)];
  if (kind === 'page') return names.map((n) => newPage(root, n));
  if (kind === 'store') return names.map((n) => newStore(root, n));
  throw new Error(`muten new: unknown kind "${kind}" — use page | store | app`);
}
