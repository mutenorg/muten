// validate-nodes: the page's tree, node by node: a known type, the props it needs, refs that resolve in the scope
// the node sits in (an `each` adds its row, a DataTable its `row`), links that land, icons that exist, charts over
// real fields, and every expression a node carries.
import { diag, closest } from '#engine/shared/diagnostics.js';
import { PRIMITIVE_NAMES, PRIMITIVES } from '#engine/lang/manifest.js';
import { Nt, Ek, CHART_KINDS, SVG_PRIMS, nonPrimitiveHint } from '#engine/shared/vocab.js';
import { iconNames } from '#engine/ir/icon-names.js';
import type { Expr, GeoProp, NodeCheck, StringPropValue } from '#engine/shared/types.js';

const KNOWN_TYPES = new Set<string>([...PRIMITIVE_NAMES, Nt.Shell, Nt.Layout, Nt.Slot]); // manifest primitives + Shell/Layout wrappers (app.muten roots) + Slot (part children outlet, or a shell/layout's page outlet)
// native primitives that share a name with common plugin (shadcn) parts → a part-style call resolves to the
// primitive and trips `missing-prop`; the value is the native usage to point the AI at.
const SHADOWED_PRIMITIVE: { readonly [k: string]: string } = { [Nt.Select]: 'Select bind(x) options(a, b)', [Nt.Checkbox]: 'Checkbox bind(ok)', [Nt.Number]: 'Number bind(n)', [Nt.Range]: 'Range bind(v) min(0) max(100)', [Nt.Date]: 'Date bind(d)', [Nt.Chart]: 'Chart @data kind(bar) x(field) y(field)' };
const REF_PROPS: Array<'bind' | 'data'> = ['bind', 'data']; // props whose value is @state
/** The geometry of an SVG mark: each is an expression. */
const GEO_PROPS: ReadonlyArray<GeoProp> = ['x', 'y', 'w', 'h', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'rx', 'start', 'end', 'inner'];
const DISABLEABLE = new Set<string>([Nt.Button, Nt.RowAction, Nt.SearchField, Nt.Textarea, Nt.Password, Nt.Select, Nt.Checkbox, Nt.Number, Nt.Range, Nt.Date, Nt.Form, Nt.Link]); // form controls, plus Link (out of Tab order + aria-disabled + no navigation)


/** The walk over a page's nodes; diagnostics go to `facts.D`. */
export function nodeWalker(facts: NodeCheck): (id: string, scope: Map<string, string>, inTable?: boolean) => void {
  const { D, doc, ctx, nodes, stateKeys, storeDomains, anchorIds, seen, EXTERNAL, checkExpr, checkAction, checkRef, dataElement, listElem, routeExists } = facts;
  const walk = (id: string, scope: Map<string, string>, inTable = false): void => {
    const n = nodes[id];
    if (!n) { D.push(diag('missing-node', `node ${id} does not exist`)); return; }
    if (seen.has(id)) { D.push(diag('dup-node', `${id} is referenced twice`, { loc: n.loc })); return; }
    seen.add(id);
    if (n.type === 'RowAction' && !inTable) D.push(diag('rowaction-context', 'RowAction only works inside a DataTable (it renders a button per row). Use Button for a standalone action.', { loc: n.loc })); // compile throws "unsupported primitive" otherwise

    if (!KNOWN_TYPES.has(n.type)) {
      if (n.args) {
        D.push(diag('unknown-part', `"${n.type}" is not a known part`, { loc: n.loc, suggestion: closest(n.type, [...(ctx.parts || [])]), from: n.type }));
      } else {
        const npHint = nonPrimitiveHint(n.type);   // a JS/React/HTML name we KNOW isn't a primitive → hand back the muten way, not a fuzzy typo guess
        D.push(npHint
          ? diag('unknown-type', `\`${n.type}\` is not a muten primitive — use ${npHint}.`, { loc: n.loc, from: n.type })
          : diag('unknown-type', `"${n.type}" is not a known primitive`, { loc: n.loc, suggestion: closest(n.type, [...KNOWN_TYPES]), from: n.type }));
      }
    } else {
      // required props: those NOT ending in "?" in the manifest
      const prim = PRIMITIVES[n.type];
      const spec = prim ? prim.props : {};
      for (const [pname, hint] of Object.entries(spec)) {
        if (!hint.endsWith('?') && !(pname in (n.props || {}))) {
          // Select/Checkbox/Number/Range/Date/Chart are native primitives that share a name with common plugin
          // (shadcn) parts — a part-style call (`Select(value: …)`) resolves to the primitive and trips this. Say so.
          const tip = SHADOWED_PRIMITIVE[n.type] ? ` — "${n.type}" is a native primitive (it shadows any same-named plugin part); use its API, e.g. \`${SHADOWED_PRIMITIVE[n.type]}\`` : '';
          D.push(diag('missing-prop', `${n.type} is missing the required "${pname}"${tip}`, { loc: n.loc }));
        }
      }
    }

    const props = n.props || {};
    for (const rp of REF_PROPS) if (rp in props) checkRef(props[rp], n);
    if (props.action) {
      checkAction(props.action, n);
      // `-> action()` where the action declares `<- input`: the call passes nothing, so the body
      // reads undefined (e.g. `p.id` -> TypeError). Require the arg. Store actions: input unknown here, skip.
      if (typeof props.action === 'string' && !props.action.includes('.') && (doc.actions?.[props.action]?.input || doc.actions?.[props.action]?.params?.length) && props.arg === undefined)
        D.push(diag('action-arity', `action "${props.action}" takes an argument (it reads "${doc.actions[props.action].params?.length ? (doc.actions[props.action].params ?? []).map((p) => p.name).join(', ') : doc.actions[props.action].input}") — pass it, e.g. \`-> ${props.action}(row)\``, { loc: n.loc }));
    }
    if (props.submit) checkAction(props.submit, n);
    if (Array.isArray(props.where)) for (const clause of props.where) if (typeof clause === 'string' && clause.trim()) { // where() compiles only `==`/`contains`, comma-separated; anything else throws or silently miscompiles
      if (!/(?:==|\bcontains\b)/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — where() supports only \`==\` and \`contains\` (e.g. where(role == admin, name contains @q)).`, { loc: n.loc, from: clause.trim() }));
      else if (/\b(?:and|or)\b/.test(clause)) D.push(diag('unsupported-where', `where clause "${clause.trim()}" — combine conditions with a COMMA, not \`and\`/\`or\`: where(role == admin, name contains @q).`, { loc: n.loc, from: clause.trim() }));
    }
    if (n.type === 'Form') { // Form auto-renders one input per entity field: must bind a page-local draft; anything else crashes the compiler (editableFields(undefined))
      const raw = String(props.bind ?? '').replace(/^@/, '');
      const b = raw.split('.')[0];
      const bt = b ? doc.state?.[b]?.type : undefined;
      // Any Form bind problem → steer OUT of `Form`, not deeper into it (the draft-entity path is a rabbit hole the
      // model loops in). muten's forms are just individual inputs; the model already has them inside the `Form {}`.
      const dropForm = 'Simplest: DON\'T use `Form`. Drop the `Form … { }` wrapper, KEEP the inner inputs (each `bind`s its OWN state — `SearchField bind(name)  SearchField bind(email)`), and add `Button "Save" -> <action>`.';
      if (bt === undefined) D.push(diag('form-bind', `\`Form\` needs an entity-draft state${raw ? `, and "${raw}" isn't one` : ''}. ${dropForm}`, { loc: n.loc }));
      else if (!doc.entities?.[bt]) D.push(diag('form-bind', `\`Form\` binds an entity draft; "${b}" is "${bt}". ${dropForm}`, { loc: n.loc }));
    }
    if (n.type === 'DataTable') { // columns + where fields must be real fields of the row entity (else blank column / dead filter / @ref crash)
      const d = String(props.data ?? '').replace(/^@/, '');
      const de = dataElement(d); // page state / query / get / store member
      // the data must be a LIST — a scalar/record here lints clean today, then crashes at runtime ("not iterable").
      if (d && de.known && !de.isList)
        D.push(diag('datatable-not-list', `DataTable shows a list, but "${d}" is not a list — bind a \`list<…>\` state, query, get, or store list.`, { loc: n.loc, from: d }));
      const rowFields = de.fields ? new Set(['id', ...Object.keys(de.fields)]) : null;
      if (rowFields) {
        const elem = de.name || 'the data';
        for (const col of (props.columns || [])) if (typeof col === 'string' && !rowFields.has(col)) D.push(diag('unknown-column', `column "${col}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(col, [...rowFields]), from: col }));
        for (const clause of (props.where || [])) if (typeof clause === 'string') {
          const field = clause.trim().split(/\s+/)[0];
          if (field && !rowFields.has(field)) D.push(diag('unknown-where-field', `where "${clause.trim()}": "${field}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(field, [...rowFields]), from: field }));
          for (const m of clause.matchAll(/@(\w+)/g)) if (!stateKeys.has(m[1])) D.push(diag('unknown-ref', `where "${clause.trim()}": "@${m[1]}" is not a declared state`, { loc: n.loc, from: '@' + m[1] }));
        }
      }
    }
    if (n.type === Nt.Checkbox) {
      // Checkbox owns a bool via `bind` (two-way page state) OR shows one via `checked(expr)` (one-way; `-> action` toggles).
      // `checked` is the store/query list-row answer: you can't two-way-bind a row, but you CAN display it + fire an action.
      const hasBind = props.bind !== undefined, hasChecked = props.checked !== undefined;
      if (hasBind && hasChecked) D.push(diag('checkbox-prop', 'Checkbox uses either `bind(state)` (you own the bool, two-way) OR `checked(expr)` (display a value you don\'t own) — not both.', { loc: n.loc }));
      else if (!hasBind && !hasChecked) D.push(diag('missing-prop', 'Checkbox needs `bind(<bool state>)` to own a value, or `checked(<bool>)` to display one (add `-> action` to toggle) — e.g. a list row: `Checkbox checked(t.done) -> todos.toggle(t.id)`.', { loc: n.loc }));
      if (hasChecked && props.checked && typeof props.checked === 'object' && 'kind' in props.checked) checkExpr(props.checked, n.loc ?? null, scope);
    }
    if ((n.type === Nt.SearchField || n.type === Nt.Textarea || n.type === Nt.Password || n.type === Nt.Select || n.type === Nt.Checkbox || n.type === Nt.Number || n.type === Nt.Range || n.type === Nt.Date || n.type === Nt.File) && props.bind !== undefined) {
      // A bound input carries one scalar. It binds a page STATE (`bind(q)`), OR — inside an `each` — a FIELD of the
      // row entity (`bind(row.value)`), which two-way-edits that list element. Either way the type must match.
      const raw = String(props.bind ?? '').replace(/^@/, '');
      const head = raw.split('.')[0], sub = raw.split('.')[1];
      const isBool = n.type === Nt.Checkbox;
      const isNum = n.type === Nt.Number || n.type === Nt.Range;
      const isDate = n.type === Nt.Date;
      const isFile = n.type === Nt.File;
      const want = isNum ? ['number'] : isBool ? ['bool'] : isDate ? ['date', 'text', 'string'] : isFile ? ['file', 'list<file>'] : ['text', 'string', 'email'];
      const kindWord = isNum ? 'a number' : isBool ? 'a bool' : isDate ? 'a date' : isFile ? 'a file' : 'a single text value';
      const hint = isNum ? 'a number state (e.g. `qty = 0 : number`)' : isBool ? 'a bool state (e.g. `agree = false : bool`)' : isDate ? 'a date state (e.g. `due = "" : date`)' : isFile ? 'a file state (`photo = null : file`, or `photos = [] : list<file>` for several)' : 'a text state (e.g. `role = "" : text`)';
      const eachElem = head && scope.has(head) ? (scope.get(head) || '') : ''; // an `each` row var -> its element entity
      if (eachElem && doc.entities?.[eachElem]) {
        const ft = sub ? (doc.entities[eachElem][sub] || (sub === 'id' ? 'uuid' : '')) : '';
        if (!sub) D.push(diag('bind-type', `${n.type} inside \`each\` edits a list item — bind one of its FIELDS: \`bind(${head}.<field>)\`.`, { loc: n.loc, from: head }));
        else if (!ft) D.push(diag('bind-type', `"${sub}" is not a field of ${eachElem}`, { loc: n.loc, suggestion: closest(sub, Object.keys(doc.entities[eachElem])), from: sub }));
        else if (isNum ? ft !== 'number' : isBool ? ft !== 'bool' : (!want.includes(ft) && !ft.startsWith('enum:'))) D.push(diag('bind-type', `${n.type} binds ${kindWord}, but ${eachElem}.${sub} is "${ft}".`, { loc: n.loc, from: sub }));
      } else if (scope.has(head) && sub) {
        // `head` is an `each` row var, but its element entity didn't resolve — the list is a STORE/query list (or an
        // unknown element type). Its rows are NOT editable through a direct input bind (write-back only works on a
        // settable page list state). Don't say "declare a state" (impossible per-row) — point at the action pattern.
        const rowFix = n.type === Nt.Checkbox
          ? `for a bool toggle use \`Checkbox checked(${head}.${sub}) -> <action>(${head}.id)\` (checked = display, -> = fire the store patch)`
          : `change it with an action fired by a Button (\`-> <action>(${head}.id)\` running \`patch where id == ${head}.id with { ${sub}: … }\`)`;
        D.push(diag('bind-type', `${n.type} binds a field of the \`each\` row "${head}", but rows of a store/query list can't be two-way-bound — ${rowFix}. (Or iterate a settable page \`state\` list to bind fields directly.)`, { loc: n.loc, from: head }));
      } else {
        const bt = head ? doc.state?.[head]?.type : undefined;
        const storeBind = head ? storeDomains.has(head) : false; // a store text field (e.g. `ide.msg`) — two-way bound like SearchField, valid at runtime; a dock/part input needs global state, so binding a store scalar is the intended pattern
        // SearchField stays lenient about existence (legacy); the newer inputs require a real page state OR a store field.
        if (n.type !== Nt.SearchField && head && bt === undefined && !storeBind) D.push(diag('bind-type', `${n.type} binds "${head}", which is not a state on this page — declare ${hint}.`, { loc: n.loc, suggestion: closest(head, [...stateKeys]), from: head }));
        else if (bt !== undefined && !want.includes(bt)) D.push(diag('bind-type', `${n.type} binds ${kindWord}, but "${head}" is "${bt}" — bind ${hint}.`, { loc: n.loc }));
      }
    }
    if (n.type === 'Custom') { // inputs(@state) + on(action) were unvalidated: undefined refs / missing actions crash at runtime
      // a component from npm takes its props like a part, bare: `Rating(value: stars)` reads `stars`, checked in scope
      const fromNpm = (doc.imports || []).some((def) => def.kind && def.names.includes((props.component || '').split('.')[0]));   // `Dialog.Root`: its library's
      for (const v of Object.values(props.inputs || {})) {
        if (typeof v === 'string') { if (fromNpm && !v.startsWith('@')) checkExpr({ kind: Ek.Ref, name: v }, n.loc ?? null, scope); else checkRef(v, n); }
        else if (typeof v === 'object' && '$expr' in v) checkExpr(v.$expr, n.loc ?? null, scope);   // `animate: { opacity: shown ? 1 : 0 }`
      }
      for (const v of Object.values(props.on || {})) if (typeof v === 'string') checkAction(v, n);
    }
    if (n.type === Nt.Chart) { // data must be a list; x/y/color must be real fields; y must be numeric; kind bounded
      const d = String(props.data ?? '').replace(/^@/, '');
      const de = dataElement(d); // page state / query / get / store member — the store-centric pattern derives via get
      if (d && de.known && !de.isList)
        D.push(diag('chart-not-list', `Chart plots a list, but "${d}" is not a list — bind a \`list<…>\` state, query, get, or store list.`, { loc: n.loc, from: d }));
      if (typeof props.kind === 'string' && !CHART_KINDS.has(props.kind))
        D.push(diag('chart-kind', `Chart kind "${props.kind}" is not one of bar / line / area / point / scatter / pie / donut.`, { loc: n.loc, suggestion: closest(props.kind, [...CHART_KINDS]), from: props.kind }));
      const elem = de.name || 'the data';
      const rowFields = de.fields ? new Set(['id', ...Object.keys(de.fields)]) : null;
      // Chart reads x/y as bare FIELD refs (not coordinate expressions); '' when absent, null when a non-ref expr.
      const chartField = (e: Expr | undefined): string | null => e === undefined ? '' : (e.kind === Ek.Ref && !e.name.includes('.') ? e.name : null);
      const xf = chartField(props.x), yf = chartField(props.y);
      if (xf === null) D.push(diag('chart-field', `Chart x must be a field of ${elem} (e.g. \`x(month)\`), not an expression.`, { loc: n.loc }));
      if (yf === null) D.push(diag('chart-field', `Chart y must be a numeric field (e.g. \`y(revenue)\`), not an expression.`, { loc: n.loc }));
      if (rowFields) {
        const encodings: Array<[string, string | null]> = [['x', xf], ['y', yf], ['color', props.color ?? '']];
        for (const [enc, f] of encodings)
          if (typeof f === 'string' && f && !rowFields.has(f)) D.push(diag('chart-field', `Chart ${enc}(${f}): "${f}" is not a field of ${elem}`, { loc: n.loc, suggestion: closest(f, [...rowFields]), from: f }));
        const yt = typeof yf === 'string' && yf ? (de.fields?.[yf] || '') : '';
        if (yt && yt !== 'number') D.push(diag('chart-field', `Chart y(${yf}): "${yf}" is "${yt}", but y must be a number field (it is the value axis).`, { loc: n.loc, from: yf }));
      }
    }
    if (SVG_PRIMS.has(n.type)) { // SVG mark geometry are EXPRESSIONS — validate their refs (e.g. `map(unknownState, …)`)
      for (const g of GEO_PROPS) { const e = props[g]; if (e) checkExpr(e, n.loc ?? null, scope); }
      for (const s of [props.d, props.transform]) if (s && typeof s === 'object' && 'kind' in s) for (const part of s.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
    }
    // target restrictions: kind/color = Chart-only; SVG geometry = mark-only; x/y = Chart OR SVG; viewBox = Svg-only.
    if ((props.kind || props.color) && n.type !== Nt.Chart) D.push(diag('encoding-target', `kind / color only apply to Chart, not ${n.type}.`, { loc: n.loc, from: n.type }));
    if ((props.w || props.h || props.cx || props.cy || props.r || props.x1 || props.y1 || props.x2 || props.y2 || props.rx || props.start || props.end || props.inner || props.d || props.transform) && !SVG_PRIMS.has(n.type))
      D.push(diag('encoding-target', `SVG geometry (w/h/cx/cy/r/start/end/inner/d/transform) only applies to Svg marks (Rect/Line/Circle/Arc/Path/Group), not ${n.type}.`, { loc: n.loc, from: n.type }));
    if ((props.x || props.y) && n.type !== Nt.Chart && !SVG_PRIMS.has(n.type)) D.push(diag('encoding-target', `x / y only apply to Chart or an SVG mark, not ${n.type}.`, { loc: n.loc, from: n.type }));
    if (props.viewBox && n.type !== Nt.Svg) D.push(diag('encoding-target', `viewBox only applies to Svg, not ${n.type}.`, { loc: n.loc, from: n.type }));
    // Icon resolves to inline SVG at BUILD, so its name must be a static `set:name` literal. A data-driven name
    // (`Icon "{m.icon}"`) parses to an Interp, NOT a string — so the old `typeof === 'string'` check missed exactly
    // the case it claimed to catch (a per-row icon from data). Catch BOTH: the interpolated form and the missing set.
    if (n.type === Nt.Icon) {
      const nm = props.name;
      if (typeof nm === 'string') { // Icon's name is a RAW string (not interp-parsed): `{x}` stays literal text
        if (nm.includes('{') || !nm.includes(':'))
          D.push(diag('icon-name', `Icon "${nm}" must be a static "set:name" literal — icons inline as SVG at build (tree-shaken), so the name can't come from data. Two ways to get a data-driven icon: (1) per-VALUE (status/type/category) → \`match\`: \`match item.status { active -> Icon "lucide:check"  paused -> Icon "lucide:pause" }\` (each arm inlines + tree-shakes); (2) an icon/image whose URL is in your data → use \`Image "{item.iconUrl}"\` instead.`, { loc: n.loc, from: nm }));
        else if (ctx.iconExists) { // shape is fine — does the name actually exist in the set? (a build-only check until now: a typo'd name lints green, then blanks the page)
          const err = ctx.iconExists(nm);
          if (err) D.push(diag('icon-name', `Icon "${nm}": ${err}`, { loc: n.loc, from: nm }));
        }
      } else if (nm && 'kind' in nm && nm.kind === Ek.Interp) {   // `Icon "{tab.icon}"`: fine when the page spells out every name it can be
        for (const part of nm.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
        const names = iconNames(nm, doc);
        if (!names) D.push(diag('icon-name', `Icon's name comes from data the build cannot see: icons inline as SVG, so every name it can take must be written in the page. Choose between names (\`Icon "{done ? "lucide:check" : "lucide:circle"}"\`), read it from a list written in the page (\`state { tabs = [ { icon: "lucide:house" } ] : list }\` + \`each tabs as tab { Icon "{tab.icon}" }\`), or per value with \`match\`. An icon whose URL is in your data is an \`Image "{item.iconUrl}"\`.`, { loc: n.loc }));
        else for (const each of names) {
          const err = !each.includes(':') ? 'is not a "set:name"' : ctx.iconExists ? ctx.iconExists(each) : null;
          if (err) D.push(diag('icon-name', `Icon "${each}" (one of the names this Icon can take): ${err}`, { loc: n.loc, from: each }));
        }
      }
    }
    // expression references: when condition, each list, reactive Text/Image interpolation
    if (n.type === Nt.When && props.cond) {
      checkExpr(props.cond, n.loc ?? null, scope);
      // `when <list>` is ALWAYS truthy (an empty array is truthy) — the obvious reading ("if it has items") is wrong.
      if (props.cond.kind === Ek.Ref) { const ct = (doc.state || {})[props.cond.name]?.type; if (ct && (ct === 'list' || ct.startsWith('list<'))) D.push(diag('when-list', `\`when ${props.cond.name}\` tests a list, which is ALWAYS truthy (even when empty). Use \`when ${props.cond.name}.length > 0\` to render only when it has items.`, { loc: n.loc, suggestion: `${props.cond.name}.length > 0`, from: props.cond.name })); }
    }
    if (n.type === Nt.Each && props.list) {
      checkExpr(props.list, n.loc ?? null, scope);
      // the iterated head must be a LIST — a scalar/record state here lints clean and then crashes at runtime
      // ("not iterable"). Catch the common case: a bare ref to a non-list page state.
      if (props.list.kind === Ek.Ref) {
        const lt = (doc.state || {})[props.list.name]?.type;
        if (lt && lt !== 'list' && !lt.startsWith('list<')) D.push(diag('each-not-list', `each iterates a list, but "${props.list.name}" is "${lt}" — use a \`list<…>\` state (or a query/list)`, { loc: n.loc, from: props.list.name }));
      }
    }
    if (props.arg) checkExpr(props.arg, n.loc ?? null, scope); // `-> action(arg)` on Button/Link/RowAction: arg was previously unchecked
    if (props.argRest) for (const a of props.argRest) checkExpr(a, n.loc ?? null, scope);                                     // 2nd+ args of a multi-arg call `-> f(a, b)`
    if (Array.isArray(props.class)) for (const c of props.class) if (typeof c !== 'string') { // reactive class: cond / interpolated refs were unchecked → a stale state ref passed lint but shipped a runtime ReferenceError
      if ('cond' in c) checkExpr(c.cond, n.loc ?? null, scope);
      else if ('interp' in c) for (const pt of c.interp.parts) if (typeof pt !== 'string') checkExpr(pt, n.loc ?? null, scope);
    }
    if (props.disabled) { // `disabled when <cond>`: the condition is a real expression, and it only affects form controls
      checkExpr(props.disabled, n.loc ?? null, scope);
      if (!DISABLEABLE.has(n.type)) D.push(diag('disabled-target', `\`disabled\` does nothing on ${n.type} — it applies to form controls (Button, RowAction, SearchField, Password, Select, Checkbox, Form) and to Link.`, { loc: n.loc, from: n.type }));
    }
    if (props.draggable) checkExpr(props.draggable, n.loc ?? null, scope); // `draggable(item.id)` — the id expression is real
    if (props.dropGroup && typeof props.dropGroup !== 'string' && 'kind' in props.dropGroup) // `droptarget("{row.id}")` — the interpolated refs are real
      for (const part of props.dropGroup.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
    for (const v of Object.values(props.on || {})) if (typeof v === 'string' && n.type !== 'Custom') checkAction(v, n); // on(event: action) on any element — the action must exist (Custom's on() is checked above)
    if (props.aria) for (const expr of Object.values(props.aria)) checkExpr(expr, n.loc ?? null, scope);  // `aria(key: expr)` values are real expressions: an unknown/renamed state ref is caught here, not at runtime
    if (props.styleVars) for (const sv of Object.values(props.styleVars)) if (typeof sv !== 'string') for (const pt of sv.parts) if (typeof pt !== 'string') checkExpr(pt, n.loc ?? null, scope);  // `style(w: "{ref}")` interpolations: an unknown state ref is caught here, not at runtime
    // Page already carries the compiler-emitted id `mu-main` (the skip-link target); overriding it silently breaks a11y.
    if (props.id && n.type === Nt.Page) D.push(diag('id-target', `Page already owns the id "mu-main" (the skip-link target) — put id() on a Section/Stack inside it`, { loc: n.loc }));
    if (props.eager && n.type !== Nt.Image) D.push(diag('eager-target', `eager only loads an Image at once — ${n.type} has no image to load`, { loc: n.loc }));
    if (props.group && n.type !== Nt.Details) D.push(diag('group-target', `group() only groups a Details (one open at a time) — ${n.type} has nothing to open`, { loc: n.loc }));
    const interps: StringPropValue[] = [];
    if ((n.type === Nt.Text || n.type === Nt.Title || n.type === Nt.Span) && props.value) interps.push(props.value);
    if (n.type === Nt.Image) { if (props.src) interps.push(props.src); if (props.alt) interps.push(props.alt); }
    if (n.type === Nt.Link && props.to) interps.push(props.to);
    // Every STATIC link target must land somewhere. An interpolated href (`/product/{p.id}`) is data-driven and
    // unknowable at build time, so it is skipped — the same stance as a data-driven Icon name.
    if (n.type === Nt.Link && typeof props.to === 'string' && props.to && !EXTERNAL.test(props.to)) {
      const href = props.to;
      if (href[0] === '#') {                                    // in-page anchor: something must declare id("…")
        const anchor = href.slice(1);
        if (anchor && !anchorIds.has(anchor)) D.push(diag('unknown-anchor', `nothing on this page declares id("${anchor}") — the link "${href}" scrolls nowhere`, { loc: n.loc, from: anchor, suggestion: closest(anchor, anchorIds) }));
      } else if (href[0] === '/' && ctx.routes) {                // a real path: it must be a route declared in app.muten
        const path = href.split('#')[0].split('?')[0];
        if (!routeExists(path)) D.push(diag('unknown-route', `no route "${path}" is declared in app.muten — this link goes nowhere`, { loc: n.loc, from: path, suggestion: closest(path, ctx.routes) }));
        // The router's `go()` bails when the target equals the current path, so a link to THIS page's own route is
        // provably dead: it renders, it is clickable, and nothing happens. That is the whole reason generated
        // landings ship a navbar of no-ops — the model has nowhere else to point when it has only one route.
        // (A persistent `shell` nav is exempt: it has no route of its own, so `selfRoute` is never threaded there
        //  and the router's `is-active` marking of the current item keeps working.)
        // TEMPORARILY a WARNING, not an error. It is provably dead and it should be an error — but the showcase corpus
        // still carries ~458 of these decorative placeholder links, and an error there blocks `muten dev` for the whole
        // reference library. Promote back to `error` the moment `muten check builder/templates` is green.
        else if (ctx.selfRoute && path === ctx.selfRoute) D.push(diag('self-link', `this link points at the page it is already on ("${path}") — clicking it does nothing. Pick the one that matches what it really is: (1) a VIEW or filter of this same page (Starred / Sent / a tab) is STATE, not navigation — \`state { view = "inbox" : text }\` + \`Button "Starred" -> pick("starred")\` + \`each mail where folder == view\`; (2) a SECTION of this page is an anchor — \`-> "#pricing"\` with \`Stack id("pricing")\`; (3) another PAGE is its real route, which you must have created; (4) the current page's own nav item is not a link at all — render it as a \`Span\` with your active class.`, { loc: n.loc, from: path, severity: 'warning' }));
      }
    }
    if (n.type === Nt.SearchField && props.placeholder) interps.push(props.placeholder); // placeholder interpolates ("Message #{channel}")
    if (props.label) interps.push(props.label); // Link/Button/RowAction labels interpolate too
    for (const ip of interps) {
      if (typeof ip === 'object' && 'kind' in ip && ip.kind === Ek.Interp) {
        for (const part of ip.parts) if (typeof part !== 'string') checkExpr(part, n.loc ?? null, scope);
      }
    }

    // children inherit the scope; `each` adds its item variable and DataTable adds the implicit `row`
    // (its RowActions read `row.id`), both typed with the list's element entity.
    let childScope = scope;
    if (n.type === Nt.Each && props.as) {
      childScope = new Map<string, string>([...scope, [props.as, listElem(props.list)]]);
      if (props.index) { // `as item, i`: i is a number (position). Same name as the item shadows it → the item ref would read a number at runtime, lint-clean — catch it.
        if (props.index === props.as) D.push(diag('each-index-name', `the index variable "${props.index}" must differ from the item variable "${props.as}" (it shadows the item)`, { loc: n.loc, from: props.index }));
        childScope = new Map<string, string>([...childScope, [props.index, 'number']]);
      }
      if (props.filter) checkExpr(props.filter, n.loc ?? null, childScope); // `where <cond>` reads the item var
    }
    else if (n.type === 'DataTable') {
      const d = String(props.data || '').replace(/^@/, '');
      childScope = new Map<string, string>([...scope, ['row', dataElement(d).name]]); // RowActions read `row.id` — bind `row` to the element entity (state / get / store)
    }
    for (const c of n.children || []) walk(c, childScope, n.type === 'DataTable');
  };
  return walk;
}
