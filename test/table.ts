// Native Table/Row/Cell primitives: a `Table` groups its `Row` children into real <thead>/<tbody>, a `Row head`
// makes header cells (<th>), and a `Cell` is a <td> (text or rich children). Covers the static (zero-JS) path
// and the reactive DOM path.
import { parse } from '#engine/lang/parse.js';
import { toDoc } from '#engine/ir/flatten.js';
import { compile } from '#engine/compile/compile.js';
import { validate } from '#engine/ir/validate.js';

let f = 0;
const ok = (l: string, c: boolean, e = ''): void => { console.log((c ? '✓' : '✗') + ' ' + l + (c ? '' : '  ← ' + e)); if (!c) f++; };

// ── 1. static table → a real <table>/<thead>/<tbody>/<th>/<td>, zero JS ──
{
  const src = `screen t
Table class("table table-sm") {
  Row head { Cell "Name"  Cell "Role" }
  Row { Cell "Ana"  Cell { Span "Admin" class("badge") } }
}`;
  const doc = toDoc(parse(src));
  const v = validate(doc);
  ok('static table validates (text + rich + optional value)', v.ok, JSON.stringify(v.diagnostics));
  const html = compile(doc, {});
  ok('static (no <script>) with <table>', html.includes('<table') && !html.includes('<script'), html.slice(0, 80));
  ok('head rows grouped in <thead>', html.includes('<thead>'), '');
  ok('body rows grouped in <tbody>', html.includes('<tbody>'), '');
  ok('header cell -> <th>', /<th[ >]/.test(html), '');
  ok('body cell -> <td>', /<td[ >]/.test(html), '');
  ok('class() carried onto <table>', html.includes('table-sm'), '');
  ok('mu-table / mu-row / mu-cell base classes', html.includes('mu-table') && html.includes('mu-row') && html.includes('mu-cell'), '');
  ok('cell text present', html.includes('Name') && html.includes('Ana'), '');
}

// ── 2. reactive table (aria forces the DOM path) → build it in a fake DOM and inspect the tree ──
{
  const src = `screen t
Table class("table") aria(label: "Users") {
  Row head { Cell "Name" }
  Row { Cell "Ana" }
}`;
  const doc = toDoc(parse(src));
  ok('reactive table validates', validate(doc).ok, '');
  const out = compile(doc, {});
  const code = out.split('<script type="module">')[1].split('</script>')[0];
  ok('DOM path emits createElement("table")', code.includes("createElement('table')"), '');

  const registry: any[] = [];
  const makeEl = (tag: string): any => {
    const el: any = {
      tag, children: [], className: '', textContent: '', parentNode: null,
      appendChild(c: any) { c.parentNode = this; this.children.push(c); return c; },
      replaceChildren(...ns: any[]) { this.children = []; for (const n of ns) this.appendChild(n); },
      insertBefore(n: any, ref: any) { n.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, n); else this.children.push(n); return n; },
      removeChild(c: any) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
      remove() {}, setAttribute() {}, addEventListener() {},
    };
    registry.push(el); return el;
  };
  const app = makeEl('app');
  const document = { getElementById: () => app, createElement: (t: string) => makeEl(t), createComment: () => ({ parentNode: null, remove() {} }) };
  new Function('document', code)(document);

  const table = registry.find((e) => e.tag === 'table');
  const thead = registry.find((e) => e.tag === 'thead');
  const tbody = registry.find((e) => e.tag === 'tbody');
  const th = registry.find((e) => e.tag === 'th');
  const td = registry.find((e) => e.tag === 'td');
  ok('real <table> in the DOM', !!table, '');
  ok('<thead> child of <table>', !!thead && thead.parentNode === table, '');
  ok('<tbody> child of <table>', !!tbody && tbody.parentNode === table, '');
  ok('header cell is <th> in a <tr> in <thead>', !!th && th.parentNode?.tag === 'tr' && th.parentNode?.parentNode === thead, '');
  ok('body cell is <td> in a <tr> in <tbody>', !!td && td.parentNode?.tag === 'tr' && td.parentNode?.parentNode === tbody, '');
  ok('th carries its text', th?.textContent === 'Name', th?.textContent);
  ok('td carries its text', td?.textContent === 'Ana', td?.textContent);
}


// ── data(...) → data-* attributes (static literal + reactive state), the hooks component CSS styles by ──
{
  const src = `screen t
state { open = false : bool }
Stack class("card") data(slot: "card", size: "sm") aria(label: "Card") {
  Span "x" data(state: open)
}`;
  const doc = toDoc(parse(src));
  ok('data() validates', validate(doc).ok, JSON.stringify(validate(doc).diagnostics));
  const out = compile(doc, {});
  ok('data(slot) → static setAttribute("data-slot")', out.includes('setAttribute("data-slot", String("card"))'), out.slice(0, 200));
  ok('data(size) keeps its name, aria(label) still → aria-label', out.includes('"data-size"') && out.includes('"aria-label"'), '');
  ok('data(state: open) is reactive (effect)', /effect\(\(\) => \{ const __av = String\(.*?\); if \(__av === ''\) el_\w+\.removeAttribute\("data-state"\)/.test(out), out);
  let bad = false; try { toDoc(parse('screen t\nStack data(slot: "a" class("b")) { Span "x" }')); } catch { bad = true; }
  ok('modifiers nested inside data() are refused like aria()', bad, '');
}

// ── an EMPTY aria()/data() value writes no attribute: a part's optional label = "" must not erase the name ──
{
  const src = `screen t
state { tip = "" : text }
Stack {
  Button "x" aria(label: "") data(name: "")
  Button "y" aria(label: "Editar")
  Span "z" aria(label: tip)
}`;
  const doc = toDoc(parse(src));
  ok('empty aria/data values validate', validate(doc).ok, JSON.stringify(validate(doc).diagnostics));
  const out = compile(doc, {});
  ok('label "" → no aria-label / data-name written', !out.includes('setAttribute("aria-label", String(""))') && !out.includes('setAttribute("data-name", String(""))'), out);
  ok('label "Editar" → aria-label written', out.includes('setAttribute("aria-label", String("Editar"))'), out);
  ok('a live value that turns empty removes the attribute', out.includes('removeAttribute("aria-label")'), out);
  // a state named like the effect's local (v) must not be shadowed by it: `const v = String(v.get())` throws
  const shadow = compile(toDoc(parse('screen t\nstate { v = "x" : text }\nStack { Span "y" aria(label: v) }')), {});
  ok('the live-attribute local cannot shadow a state of the page', !/const v = String\(v\./.test(shadow) && /const __av = String\(v\./.test(shadow), shadow);
}


// ── a childless primitive given children (Span "" { Icon … }) is named, not silently emptied ──
{
  const doc = toDoc(parse('screen t\nStack {\n  Span "" { Icon "lucide:x" }\n  Stack { Icon "lucide:x" }\n}'));
  const found = validate(doc).diagnostics.filter((d) => d.code === 'leaf-children');
  ok('Span with children → leaf-children error', found.length === 1 && found[0].severity === 'error' && /Stack/.test(found[0].message), JSON.stringify(found));
  ok('a Stack with children is fine', found.every((d) => !/^Stack /.test(d.message)), '');
}

// ── initials(): first + last word, what an avatar shows ──
{
  const doc = toDoc(parse(`screen t
state { who = "Valentina Ruiz" : text }
Span "{initials(who)} {hue(who)}"`));
  ok('initials() is a known builtin', validate(doc).ok, JSON.stringify(validate(doc).diagnostics));
  const out = compile(doc, {});
  const fn = /function initials\(s\) \{[^\n]*\}/.exec(out)?.[0] ?? '';
  const initials = new Function(fn + '; return initials;')();
  ok('initials("Valentina Ruiz") = VR', initials('Valentina Ruiz') === 'VR', initials('Valentina Ruiz'));
  const hueFn = new Function((/function hue\(s\) \{[^\n]*\}/.exec(out)?.[0] ?? '') + '; return hue;')();
  ok('hue() is stable and 0-359 ("Valentina Ruiz" twice = same)', hueFn('Valentina Ruiz') === hueFn('Valentina Ruiz') && hueFn('Valentina Ruiz') >= 0 && hueFn('Valentina Ruiz') < 360 && hueFn('Ana') !== hueFn('Valentina Ruiz'), String(hueFn('Valentina Ruiz')));
  ok('initials("ana") = A, "  María  José  Pérez " = MP, "" = ""', initials('ana') === 'A' && initials('  María  José  Pérez ') === 'MP' && initials('') === '', '');
}

if (f) { console.error(`\n${f} FAILED`); process.exit(1); }
console.log('\nALL OK');
