// compile.ts: IR -> runnable code. The DOM half of the compiler.
// Walks the flat node tree and emits imperative DOM construction + fine-grained effects (text
// interpolation, when/each, DataTable, Form). No virtual DOM: the abstraction compiles away.
//
// DELIBERATELY REGULAR. Every node emits the SAME shape: createElement -> attributes -> effects -> append.
// The output is repetitive on purpose. The goal is not the smallest JS — it's the most PREDICTABLE JS:
// gzip already crushes the repetition (raw is large, shipped is tiny), and a single, uniform pattern is
// AI-locatable, trivially debuggable, and easy to optimize later if ever needed. Do NOT trade that
// regularity for bytes: no static-subtree template cloning, no effect fusion, no DocumentFragment batching,
// no event delegation — those split the codegen into many special-case strategies to save a few hundred
// bytes that gzip would have removed anyway. One node, one pattern. (See memory: muten-codegen-regularity.)
// Behaviour (expressions, action statements, state/action/effect decls) lives in logic.ts;
// output templates (HTML/module/store wrappers) live in emit.ts. compile() orchestrates all three.
// Static filters (role == admin) are pushed to the query; dynamic ones (name contains @q) stay
// reactive. A page with no reactivity compiles to plain HTML with zero runtime (Astro-like).

import { Nt, Ek, Fmt, URL_ATTRS, CUSTOM_MODULE, UseKind, SKIP_LINK_TEXT } from '#engine/shared/vocab.js';
import { CONTAINERS, editableFields, headCellIds } from '#engine/compile/helpers.js';
import { emitStore, emitStatic, emitStaticHtml, emitSsr, emitModule, emitHtml, emitPatch } from '#engine/compile/emit.js';
import { inlineSourceMap } from '#engine/compile/sourcemap.js';
import { Logic } from '#engine/compile/logic.js';
import { getOrder } from '#engine/ir/refs.js';
import { formLines } from '#engine/compile/form.js';
import { staticRenderer } from '#engine/compile/static.js';
import { callReturns } from '#engine/ir/refs.js';
import { FIELDS_NODES } from '#engine/compile/fields.js';
import { SVG_NODES } from '#engine/compile/svg.js';
import { TABLES_NODES } from '#engine/compile/tables.js';
import { CUSTOM_NODES } from '#engine/compile/custom.js';
import { dynamicsLines } from '#engine/compile/dynamics.js';
import { MEDIA_NODES } from '#engine/compile/media.js';
import { CONTROLS_NODES } from '#engine/compile/controls.js';
import { foreignImport, REACT_RUNTIME, scriptGlobals } from '#engine/compile/foreign.js';
import { speakTable } from '#engine/compile/translate.js';
import { REACT_HELPERS, withThemeImports } from '#engine/compile/react-tree.js';
import { foreignNames } from '#engine/ir/calls.js';
import type {
  Doc, NodeProps, Scope, Interp, StringPropValue, Value, Expr, Loc,
  CompileOpts, CompileCtx, StoreInput, EmitParts, Emitter, NodeEmitter,
} from '#engine/shared/types.js';

// Emit a .muten page as an ESM module (for the Vite pipeline): exports mount(root) + css.
// opts.stores lets the page reference app-global store domains.
export function compileModule(doc: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  return compile(doc, data, projectCss, components, sources, { ...opts, format: Fmt.Module });
}

// HMR: emit ONE node's subtree as a `(ctx, nodes, parent, __rt) => element` builder — refs go through the live
// `ctx` so a re-built node binds to the SAME signals. The dev server sends this; the runtime applies it by id.
export function compileNodePatch(doc: Doc, nodeId: string, opts: CompileOpts = {}): string {
  return compile(doc, {}, '', {}, {}, { ...opts, format: Fmt.Patch, patchRoot: nodeId, ctxRefs: true });
}

// the primitives whose code lives in a file of its family, by node type
const NODE_EMITTERS: ReadonlyMap<string, NodeEmitter> = new Map([...FIELDS_NODES, ...SVG_NODES, ...TABLES_NODES, ...MEDIA_NODES, ...CONTROLS_NODES, ...CUSTOM_NODES]);

// Emit one .store domain slice (state + get + actions + effects) as a shared ESM module.
export function compileStore(input: StoreInput = {}, data: { [name: string]: Value } = {}, sources: { [name: string]: Value } = {}): string {
  const { state = {}, gets = {}, fns = {}, actions = {}, effects = [], entities = {}, imports = [] } = input;
  // A store reads and calls the OTHER stores exactly like a page does; its own name stays local.
  const others = Object.fromEntries(Object.entries(input.stores || {}).filter(([domain]) => domain !== input.domain));
  return compile({ screen: 'store', entities, state, actions, gets, fns, effects, imports, consts: {}, constraints: {}, rootId: undefined, nodes: {} }, data, '', {}, sources, { format: Fmt.Store, persistScope: input.domain, dev: input.dev, api: input.api, stores: others, translations: input.translations, themeValues: input.themeValues });
}

export function compile(page: Doc, data: { [name: string]: Value } = {}, projectCss = '', components: { [name: string]: string } = {}, sources: { [name: string]: Value } = {}, opts: CompileOpts = {}): string {
  const doc = withThemeImports(page, opts.themeKit);   // what theme.muten's providers call (react-tree.ts)
  const { nodes, rootId, state, entities, screen } = doc;

  let lines: string[] = [];
  let hasSlot = false; // a shell with `slot` returns its outlet from mount() so the router can target it

  // run a callback against a fresh buffer and return the lines it emitted: captures when/each bodies
  // into their own mount functions before splicing them back at runtime.
  const capture = (emit: () => void): string[] => { const saved = lines; lines = []; emit(); const out = lines; lines = saved; return out; };

  // A styling plugin (e.g. DaisyUI) may REMAP a primitive's internal class names — the Form's auto-generated
  // input/label/submit/… that class() can't reach — to a library's own classes. The engine ships ONLY the
  // `mu-*` defaults and stays agnostic; the map is pure data from `muten({ styling: { classes } })`.
  const classMap = opts.classes || {};
  const slot = (name: string, fallback: string): string => classMap[name] ?? fallback;

  // class() = raw CSS classes passed straight through (the one styling path).
  const classFor = (base: string, props: NodeProps): string => {
    // conditional class (`name when cond`) is omitted here and toggled reactively by genDynamics.
    // A primitive's base class is `mu-`-prefixed by default (so muten never collides with a framework's own
    // .stack/.card/…); a styling plugin may remap it via `classes`. Your look goes through class().
    return [slot(base, 'mu-' + base), ...(props.class || []).filter((c): c is string => typeof c === 'string')].join(' ');
  };

  // Shared compile context + the behaviour compiler that reads it (see logic.ts). `usedStores`
  // is the same Set both halves mutate, so a store touched in an expression here gets imported below.
  const stateKeys = new Set(Object.keys(state));
  const queryStates = new Set<string>(
    Object.entries(state).filter(([, def]) => typeof def.source === 'string' && def.source.startsWith('query:')).map(([name]) => name),
  );
  const usedStores = new Set<string>();
  const ctx: CompileCtx = {
    state, entities, actions: doc.actions, consts: doc.consts || {}, gets: doc.gets || {}, effects: doc.effects || [],
    stateKeys, queryStates, stores: opts.stores || {}, usedStores, params: new Set(doc.params || []), storeEntities: opts.storeEntities,
    fns: doc.fns || {}, calls: callReturns(doc.imports), translations: opts.translations, themeValues: opts.themeValues ?? opts.themeKit?.values, langFrom: doc.langFrom, tKeys: new Set(), tPatterns: [], foreign: foreignNames(doc), useCalls: new Set((doc.imports || []).filter((def) => !def.kind).flatMap((def) => def.names)),
    ownCalls: new Set([...Object.keys(doc.fns || {}), ...(doc.imports || []).filter((def) => !def.kind).flatMap((def) => def.names)]), persistScope: opts.persistScope ?? screen, format: opts.format, ctxRefs: opts.ctxRefs, dev: !!opts.dev,
  };
  const logic = new Logic(ctx);
  const pageScope: Scope = { locals: new Set() }; // page-level scope for interpolation, when/each

  // reactive element bits: id, conditional classes, events, drag, aria/data, disabled, style() (dynamics.ts)
  const genDynamics = (id: string, p: NodeProps): void => { dynamicsLines(emitter, id, p); };

  const genChildren = (id: string, parentVar: string): void => {
    if (opts.format === Fmt.Patch) return; // HMR patch: emit the node's OWN element only; patchNode re-parents the live children
    for (const childId of nodes[id].children) genNode(childId, parentVar);
  };

  // interpolation parts joined into a JS string expression: "Hi, " + String(name ?? '') + ...
  const interpConcat = (value: Interp): string =>
    value.parts.map((part) => typeof part === 'string' ? JSON.stringify(part) : `String(${logic.compileExpr(part, pageScope)} ?? '')`).join(' + ');

  // The regular node shape's bookends, emitted once instead of retyped in every case: declare the element +
  // set its class, then (after attributes/effects) attach it to its parent. Identical lines to before — this
  // factors the COMPILER's repetition, not the OUTPUT's: every node still emits create -> class -> … -> append.
  const declEl = (id: string, tag: string, cls: string): void => {
    lines.push(`const el_${id} = document.createElement('${tag}');`);
    lines.push(`el_${id}.className = ${JSON.stringify(cls)};`);
  };
  // appendEl is the uniform "attach element to parent" — so registering the node for HMR here covers every
  // element primitive at once (no per-type code). Dev/patch only; prod bundles + SSR/static/store omit it (dead there).
  const appendEl = (id: string, parentVar: string): void => {
    lines.push(`${parentVar}.appendChild(el_${id});`);
    // `owner`/`oloc` say which PART FILE a node was written in and where — a node inlined from a part has no `loc`,
    // because that would be a line number belonging to another file. The element picker edits `owner:oloc`, not `loc`.
    if (opts.dev || opts.format === Fmt.Patch) {
      const n = nodes[id], ty = n?.type, fp = n?.fromPart, pa = n?.partArgs, lc = n?.loc, ow = n?.ownerPart, ol = n?.partLoc;
      const at = (l: Loc): string => JSON.stringify({ line: l.line, col: l.col });
      lines.push(`__nodes[${JSON.stringify(id)}] = { el: el_${id}, parent: ${parentVar}${ty ? `, type: ${JSON.stringify(ty)}` : ''}${fp ? `, part: ${JSON.stringify(fp)}` : ''}${pa ? `, partArgs: ${JSON.stringify(pa)}` : ''}${lc ? `, loc: ${at(lc)}` : ''}${ow ? `, owner: ${JSON.stringify(ow)}` : ''}${ol ? `, oloc: ${at(ol)}` : ''} };`);
    }
  };

  // Wire a TEXT input's write path (SearchField/Textarea). A settable-list row or a plain state patches on
  // `input`; a QUERY-backed row edits the server row IN PLACE — patch `.data` locally on `input` (instant,
  // caret-safe) and persist with a `PUT` on `change` (blur). A read-only bind marks the control readOnly.
  const emitTextWrite = (id: string, bind: string | undefined, writeJS: string): void => {
    const rowW = logic.bindRowWrite(bind, pageScope, 'e.target.value');
    if (rowW) {
      // Query row: leave the field uncontrolled while typing, commit (patch + PUT) on blur. No `input` listener,
      // so the each reconcile never fires mid-keystroke and the focused field is never disrupted.
      lines.push(`el_${id}.addEventListener('change', async (e) => ${rowW.commit});`);
    } else if (writeJS) {
      lines.push(`el_${id}.addEventListener('input', (e) => ${writeJS});`);
    } else {
      lines.push(`el_${id}.readOnly = true;`);
    }
  };

  // A reactive text or attribute writes the DOM only when its value really changed. A row that comes back as a new
  // object (one field of it patched) re-runs every binding of the row: rewriting an unchanged text replaced its text
  // node anyway (two DOM mutations per field, per row, per change). __bind (runtime) keeps the last value.
  function writeOnChange(element: string, property: string, value: string): string {
    return `__bind(${element}, ${JSON.stringify(property)}, () => ${value});`;
  }

  // A field's accessible name: its text («Buscar», «Mensaje para #{canal}», kept in step when it interpolates). With
  // no text there is no name: the oracle warns (field-unnamed). It used to be the primitive's own English name
  // («Number», «Select»), which a screen reader read out on a Spanish page and an audit could no longer catch.
  function nameField(id: string, text: StringPropValue | undefined): void {
    if (typeof text === 'string') { if (text) lines.push(`el_${id}.setAttribute('aria-label', ${JSON.stringify(text)});`); }
    else if (text && 'kind' in text) lines.push(`effect(() => el_${id}.setAttribute('aria-label', ${interpConcat(text)}));`);
  }

  // text-bearing primitives (Text/Span/Title): plain string or a (possibly reactive) interpolation.
  function genTextEl(id: string, tag: string, className: string, value: StringPropValue | undefined, parentVar: string): void {
    declEl(id, tag, className);
    if (typeof value === 'string') {
      lines.push(`el_${id}.textContent = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const concat = interpConcat(value);
      const reactive = value.parts.some((part) => typeof part !== 'string'); // an embedded {expr} -> wrap in an effect
      lines.push(reactive ? writeOnChange(`el_${id}`, 'textContent', concat) : `el_${id}.textContent = ${concat};`);
    }
    appendEl(id, parentVar);
  }

  // SVG geometry: set a numeric attribute from an expression. Reactive (an effect) unless it's a literal.
  const genGeo = (id: string, attr: string, expr: Expr | undefined): void => {
    if (expr === undefined) return;
    const js = logic.compileExpr(expr, pageScope);
    lines.push(expr.kind === Ek.Lit ? `el_${id}.setAttribute(${JSON.stringify(attr)}, ${js});` : `effect(() => el_${id}.setAttribute(${JSON.stringify(attr)}, ${js}));`);
  };
  // SVG string attribute (viewBox / d / transform) from a plain or interpolated string, via setAttribute.
  const genSvgStr = (id: string, attr: string, value: StringPropValue | undefined): void => {
    if (value === undefined) return;
    if (typeof value === 'string') { lines.push(`el_${id}.setAttribute(${JSON.stringify(attr)}, ${JSON.stringify(value)});`); return; }
    if ('kind' in value) { const concat = interpConcat(value); const reactive = value.parts.some((part) => typeof part !== 'string'); lines.push(reactive ? `effect(() => el_${id}.setAttribute(${JSON.stringify(attr)}, ${concat}));` : `el_${id}.setAttribute(${JSON.stringify(attr)}, ${concat});`); }
  };

  // set an attribute from a plain string or a (possibly reactive) interpolation (Image src/alt, labels)
  // A URL that DATA builds (an interpolated href/src) goes through __safeUrl (emit.ts): a `javascript:`/`vbscript:` link, or
  // a `data:` one where only media belongs, becomes about:blank#blocked, as React does. A URL the author wrote is trusted.
  function genInterpAttr(id: string, attr: string, value: StringPropValue | undefined): void {
    if (typeof value === 'string') {
      lines.push(`el_${id}.${attr} = ${JSON.stringify(value)};`);
    } else if (value && 'kind' in value) {
      const reactive = value.parts.some((part) => typeof part !== 'string');
      const raw = interpConcat(value);
      const concat = URL_ATTRS.has(attr) && reactive ? `__safeUrl(${raw}, ${attr === 'href' ? 'false' : 'true'})` : raw;
      lines.push(reactive ? writeOnChange(`el_${id}`, attr, concat) : `el_${id}.${attr} = ${concat};`);
    }
  }

  // each-ids that are a direct child of a List: their rows render as <li> (the List supplies the <ul>/<ol>).
  const listItemEach = new Set<string>();
  for (const lid of Object.keys(nodes)) if (nodes[lid].type === Nt.List) for (const cid of nodes[lid].children || []) if (nodes[cid].type === Nt.Each) listItemEach.add(cid);

  // Cell-ids under a header row (`Row head`), also through each/when: they render as <th> instead of <td>.
  const headCells = headCellIds(nodes);

  // Emit one node + its subtree into `parentVar`. Semantic containers share one generic path;
  // every other primitive has a case below. Logic (refs, exprs, actions) is delegated to `logic`.
  // the page, as the per-family generators see it (types.ts Emitter)
  const emitter: Emitter = {
    push: (...code) => { lines.push(...code); }, capture, declEl, appendEl, classFor, slot, genDynamics, genChildren,
    interpAttr: genInterpAttr, textEl: genTextEl, genNode: (id, parentVar) => genNode(id, parentVar), nameField, textWrite: emitTextWrite, geo: genGeo, svgStr: genSvgStr, writeOnChange, interpConcat,
    logic, scope: pageScope, nodes, doc, opts, headCells, queryStates,
  };

  function genNode(id: string, parentVar: string): void {
    if (cloneable(id)) {
      lines.push(`const el_${id} = __clone(${JSON.stringify(renderStatic(id))});`);
      appendEl(id, parentVar);
      return;
    }
    const n = nodes[id];
    const p = n.props || {};
    const family = NODE_EMITTERS.get(n.type);   // a primitive whose code lives in its family's file (fields, svg, tables)
    if (family) { family(emitter, id, n, parentVar); return; }
    const cont = CONTAINERS[n.type]; // regions (Header/Nav/...) + Stack: [tag, baseClass]
    if (cont) {
      const [tag, base] = cont;
      declEl(id, tag, classFor(base, p));
      if (n.type === Nt.Nav && typeof p.label === 'string') lines.push(`el_${id}.setAttribute('aria-label', ${JSON.stringify(p.label)});`);
      // a11y by default (compiler-emitted): <main> is the focus target on navigation + the skip-link anchor.
      if (n.type === Nt.Page) lines.push(`el_${id}.id = 'mu-main'; el_${id}.tabIndex = -1;`);
      // a11y by default: a keyboard skip-link as the shell's first child, so Tab jumps past the chrome to content.
      // It ships its OWN hide-until-focus CSS (the compiler emits the element, so it must guarantee it's invisible
      // until focused — not rely on the app's stylesheet, or a non-scaffolded app shows a naked "Skip to content").
      if (n.type === Nt.Shell) lines.push(`{ if (!document.getElementById('mu-a11y-css')) { const st = document.createElement('style'); st.id = 'mu-a11y-css'; st.textContent = '.mu-skip-link{position:absolute;left:-9999px;top:8px;z-index:1000;padding:8px 16px;border-radius:6px;background:#111;color:#fff;text-decoration:none}.mu-skip-link:focus{left:8px}#mu-main:focus{outline:none}'; document.head.appendChild(st); } const sk = document.createElement('a'); sk.href = '#mu-main'; sk.className = 'mu-skip-link'; sk.textContent = (${JSON.stringify(SKIP_LINK_TEXT)})[(document.documentElement.lang || 'en').slice(0, 2)] || ${JSON.stringify(SKIP_LINK_TEXT.en)}; el_${id}.appendChild(sk); }`);
      appendEl(id, parentVar);
      genDynamics(id, p);
      genChildren(id, `el_${id}`);
      return;
    }
    switch (n.type) {

      // ── native vector layer: SVG marks. Created via createElementNS; geometry from number expressions
      // (the `map` built-in scales data → coordinates). Style with class() + CSS. The escape UNDER Chart.
      case Nt.Form: {
        const sig = logic.bindSig(p.bind);
        const entityName = state[sig]?.type; // validate rejects a non-local/non-entity bind; guard so a gap never throws a raw TypeError
        if (!entityName || !entities[entityName]) throw new Error(`Form must bind a page-local entity draft, not "${p.bind}"`);
        // The submit label goes through the SAME interpolation as any other text (a `Form … "{t(ui.lang, "id.in")}"`
        // once put the braces on the button).
        const submitLabel = p.submitLabel;
        const submitText = typeof submitLabel === 'string' ? JSON.stringify(submitLabel)
          : submitLabel && 'parts' in submitLabel ? interpConcat(submitLabel) : JSON.stringify('Submit');
        declEl(id, 'form', classFor('form', p));
        lines.push(...formLines({
          id, entityName, fields: editableFields(entities[entityName]), constraints: (doc.constraints || {})[entityName] || {},
          draft: sig, lang: doc.meta?.lang || 'en', slot, submitText, submitAction: logic.actionRef(p.submit),
        }));
        appendEl(id, parentVar);
        break;
      }

      case Nt.Text: genTextEl(id, 'p', classFor('text', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Span: genTextEl(id, 'span', classFor('span', p), p.value, parentVar); genDynamics(id, p); break;
      case Nt.Title: genTextEl(id, p.level || 'h1', classFor('title', p), p.value, parentVar); genDynamics(id, p); break; // level from keyword; <h1> default

      case Nt.When: {
        // conditional render: effect mounts children when the condition becomes true, removes them
        // when it becomes false. Comment node is the stable insertion anchor.
        if (!p.cond) throw new Error('when without a condition');
        const condJS = logic.compileExpr(p.cond, pageScope);
        const body = capture(() => genChildren(id, '__p'));
        lines.push(`function build_${id}(__p) {`);
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        // The block owns EVERYTHING between its two markers, not the nodes it had when it was built: a nested
        // `when`/`each` at the root inserts its nodes later, and a snapshot would leave those behind on hide.
        lines.push(`const start_${id} = document.createComment('when');`);
        lines.push(`const anchor_${id} = document.createComment('/when');`);
        lines.push(`${parentVar}.appendChild(start_${id}); ${parentVar}.appendChild(anchor_${id});`);
        lines.push(`let shown_${id} = null;`);
        lines.push(`onCleanup(() => { if (shown_${id}) shown_${id}.dispose(); });`);
        lines.push(`effect(() => {`);
        lines.push(`  if (${condJS}) {`);
        lines.push(`    if (!shown_${id}) { const __r = root(() => { const __f = document.createDocumentFragment(); build_${id}(__f); return __f; }); anchor_${id}.parentNode.insertBefore(__r.value, anchor_${id}); shown_${id} = __r; }`);
        lines.push(`  } else if (shown_${id}) { shown_${id}.dispose(); __leave(start_${id}, anchor_${id}); shown_${id} = null; }`);
        lines.push(`});`);
        break;
      }

      case Nt.Each: {
        // Keyed reconciliation (fine-grained, no VDOM): each row is backed by a per-row signal.
        // The body's bindings read it, so only the changed binding updates, never a full rebuild.
        // Rows are matched by `id` (never index, that bleeds state), reused/moved in place, and
        // disposed (effects too) when they leave. Focus/scroll/inputs survive live updates.
        if (!p.list || !p.as) throw new Error('each without a list or item variable');
        const wrapLi = listItemEach.has(id); // a direct child of a List: each row is its own <li>
        const listJS = logic.compileExpr(p.list, pageScope);
        const filterJS = p.filter ? logic.compileExpr(p.filter, pageScope) : ''; // `where cond`: item var bare inside .filter
        const takeJS = p.take ? logic.compileExpr(p.take, pageScope) : ''; // `take(n)`: only the first n (after filtering)
        // the body reads the row through its signal: compile refs as `<as>.get()` (restore scope after).
        // an optional index var (`as item, i`) is a second per-row signal, so `i` also compiles as `i.get()`.
        const prevSig = pageScope.sigLocals;
        pageScope.sigLocals = new Set([...(prevSig || []), p.as, ...(p.index ? [p.index] : [])]);
        // inline-editable list items: if this each iterates a settable local list state, record it so an input
        // `bind(<as>.field)` inside the body writes back a patch to that state (see logic.bindWrite).
        const srcName = p.list.kind === Ek.Ref ? p.list.name.split('.')[0] : '';
        // Record the source list for an each over a page `state` list, so `bind(<as>.field)` in the body can
        // write back: a settable LOCAL list is patched inline (logic.bindWrite); a QUERY list is edited in place
        // by a text input (logic.bindRowWrite: local patch + PUT). Stores/derived lists aren't in `stateKeys`,
        // so they stay read-only.
        const bindable = !!srcName && stateKeys.has(srcName);
        const prevItemBinds = pageScope.itemBinds;
        pageScope.itemBinds = bindable ? { ...(prevItemBinds || {}), [p.as]: srcName } : prevItemBinds;
        const body = capture(() => genChildren(id, '__p'));
        pageScope.sigLocals = prevSig;
        pageScope.itemBinds = prevItemBinds;
        lines.push(`function buildItem_${id}(__p, ${p.as}${p.index ? `, ${p.index}` : ''}) {`); // ${p.as} is the row signal; body refs compiled as ${p.as}.get() (same for the index signal)
        for (const l of body) lines.push('  ' + l);
        lines.push(`}`);
        lines.push(`const start_${id} = document.createComment('each');`);
        lines.push(`const anchor_${id} = document.createComment('/each');`);
        lines.push(`${parentVar}.appendChild(start_${id}); ${parentVar}.appendChild(anchor_${id});`);
        lines.push(`const map_${id} = new Map();`);
        lines.push(`onCleanup(() => { for (const __e of map_${id}.values()) __e.dispose(); map_${id}.clear(); });`);
        lines.push(`let order_${id} = [];`);
        lines.push(`effect(() => {`);
        // `where` sees the index var too (`each xs as x, i where i >= from`): there it is the row's place in the list
        // BEFORE the filter (a plain number), the only position a filter can ask about. The oracle already accepted
        // `i` in the where while the filter's arrow never declared it, so it threw «i is not defined» at runtime.
        const filterArgs = p.index ? `${p.as}, ${p.index}` : p.as;
        lines.push(`  const __l = ${listJS}; const __rows = (Array.isArray(__l) ? __l : [])${filterJS ? `.filter((${filterArgs}) => ${filterJS})` : ''}${takeJS ? `.slice(0, ${takeJS})` : ''};`);   // fail-closed: a non-array never crashes the loop (renders empty)
        lines.push(`  const __seen = new Set(); const __next = []; const __twins = new Map();`);
        lines.push(`  for (const __row of __rows) {`);
        lines.push(`    const __k = __rowKey(__row, __twins); __seen.add(__k);`);   // by id, else by content (runtime-key.ts)
        lines.push(`    let __e = map_${id}.get(__k);`);
        lines.push(`    if (__e) { if (!__eq(__e.data, __row)) { __e.data = __row; __e.sig.set(__row); } }`);
        // A fragment row is bracketed by two markers and its nodes are read LIVE between them, for the same
        // reason as `when`: a nested block at the row's root adds nodes after the row is built.
        const rowNodes = wrapLi
          ? `const __r = root(() => { const __c = document.createElement('li'); buildItem_${id}(__c, __sig${p.index ? ', __ix' : ''}); return __c; }); const __ns = [__r.value];`
          : `const __r = root(() => { const __c = document.createDocumentFragment(); const __a = document.createComment('row'); const __b = document.createComment('/row'); __c.appendChild(__a); buildItem_${id}(__c, __sig${p.index ? ', __ix' : ''}); __c.appendChild(__b); return [__a, __b]; }); const [__a, __b] = __r.value; const __ns = { get nodes() { const __o = [__a]; let __n = __a; while (__n !== __b && __n.nextSibling) { __n = __n.nextSibling; __o.push(__n); } return __o; } };`;
        lines.push(`    else { const __sig = signal(__row);${p.index ? ' const __ix = signal(0);' : ''} ${rowNodes} __e = { sig: __sig,${p.index ? ' idx: __ix,' : ''} ${wrapLi ? 'nodes: __ns,' : 'get nodes() { return __ns.nodes; },'} dispose: __r.dispose, data: __row }; map_${id}.set(__k, __e); }`);
        lines.push(`    __next.push(__e);`);
        lines.push(`  }`);
        lines.push(`  for (const [__k, __e] of map_${id}) if (!__seen.has(__k)) { __e.dispose(); for (const __n of __e.nodes) __n.remove(); map_${id}.delete(__k); }`);
        if (p.index) lines.push(`  for (let __i = 0; __i < __next.length; __i++) __next[__i].idx.set(__i);`); // reactive position: reorder/filter reindexes surviving rows
        lines.push(`  __order(anchor_${id}.parentNode, anchor_${id}, __next, order_${id}); order_${id} = __next;`);
        lines.push(`});`);
        break;
      }

      case Nt.Slot: { // outlet in a shell where the router mounts the active page
        if (!hasSlot) { // declare the outlet ONCE — a shell with two `slot`s would otherwise emit `const __outlet` twice (bundle crash)
          lines.push(`const __outlet = document.createElement('div');`);
          lines.push(`__outlet.className = 'muten-outlet';`);
        }
        lines.push(`${parentVar}.appendChild(__outlet);`);
        hasSlot = true;
        break;
      }

      default:
        throw new Error('unsupported primitive: ' + n.type);
    }
  }

  // ── static path: a page with no reactivity compiles to plain HTML, zero runtime (Astro-like) (static.ts) ──
  const { nodeIsStatic, subtreeIsStatic, renderStatic } = staticRenderer({ nodes, classFor, iconSvg: (ref) => (opts.iconResolver ? opts.iconResolver(ref) : ''), headCells });

  function isStatic(): boolean {
    if (opts.format === Fmt.Store) return false;  // store has no DOM; shell excluded by its `slot` (reactive type)
    if ((doc.params || []).length) return false;  // a param page needs mount(app, params), never the static path
    if (opts.routeGuard) return false;            // a guarded page runs its guard first
    if ((doc.effects || []).length) return false;   // an effect runs on load (a chart, a map, analytics): static HTML would drop it
    return Object.keys(nodes).every(nodeIsStatic);
  }

  // A STATIC SUBTREE IS ONE CLONE. Every node used to be built call by call (createElement, className, textContent,
  // appendChild): the store page was 3,304 of them. A subtree with nothing reactive inside is its renderStatic HTML,
  // parsed once (__clone keeps the template) and cloned for each copy, every row of an each included. The two paths
  // render the same markup (test/static-parity.ts). Not in dev: HMR addresses every node by id.
  function cloneable(id: string): boolean {
    return !opts.dev && (opts.format === Fmt.Module || opts.format === Fmt.Html) && nodes[id].type !== Nt.Page && subtreeIsStatic(id);
  }

  // ── orchestrate: compile every piece, then hand to the right emit target ─────────────────
  const staticPage = (opts.format === Fmt.Ssr || opts.format === Fmt.Patch) ? false : isStatic(); // SSR/Patch always render the tree (genNode)
  // route params -> local string consts read from the mount() argument (set by the router on match).
  const paramDecls = (doc.params || []).map((p) => `const ${p} = (__params || {})[${JSON.stringify(p)}] ?? '';`).join('\n  ');
  const stateDecls = [logic.genState(), logic.genActionSignals()].filter(Boolean).join('\n  ');
  const actionDecls = logic.genActions();
  // a store exports its gets (cross-module reads); a page declares them as locals inside mount() (export is illegal there).
  const getKw = opts.format === Fmt.Store ? 'export const' : 'const';
  // in dependency order, not file order: a get is a const, so one read above its line would throw on mount
  const gets = doc.gets || {};
  // gets with parameters first, as hoisted functions (a get or another function may call one declared anywhere); their
  // parameters are plain locals in the body. A store exports them like its gets.
  const fnDecls = Object.entries(doc.fns || {}).map(([name, fn]) => `${opts.format === Fmt.Store ? 'export ' : ''}function ${name}(${fn.params.join(', ')}) { return ${logic.compileExpr(fn.body, { ...pageScope, locals: new Set([...pageScope.locals, ...fn.params]) })}; }`);
  const getDecls = [...fnDecls, ...getOrder({ state, gets, entities: doc.entities || {}, storeEntities: ctx.storeEntities }).map((name) => `${getKw} ${name} = computed(() => ${logic.compileExpr(gets[name], pageScope)});`), logic.genCallQueries()].filter(Boolean).join('\n');   // a query of a function may read a get (`db`)
  const effectDecls = logic.genEffects();

  let staticHtml: string | null = null;
  if (staticPage) staticHtml = rootId ? renderStatic(rootId) : '';            // populates usedTokens via classFor
  else if (opts.format === Fmt.Patch && opts.patchRoot) genNode(opts.patchRoot, 'parent'); // HMR: just this node's subtree, into the `parent` arg
  else if (opts.format !== Fmt.Store && rootId) genNode(rootId, 'app');        // store has no DOM, only state + actions
  // __nodes: the HMR node registry (id -> { el, parent }), built by appendEl. Dev only (Patch supplies its own).
  const renderBody = (opts.dev && rootId ? 'const __nodes = {};\n  ' : '') + lines.join('\n  ');
  // a page with images starts the watcher that marks each one loaded or failed (runtime-media.ts), so CSS draws the states
  const imageWatch = opts.format !== Fmt.Store && opts.format !== Fmt.Patch && opts.format !== Fmt.Ssr && Object.values(nodes).some((n) => n.type === Nt.Image) ? '\n  __watchImages();' : '';
  // the texts this page speaks: only the keys its t() calls name, in every language (translate.ts collects them)
  const textTable = speakTable(ctx);
  // names a HMR patch builder reaches state/actions/gets/params through (the live ctx) — so a rebuilt node
  // reads the SAME signals. Stashed on the mounted element as `el.__muten.ctx`.
  const ctxNames = [...Object.keys(state), ...Object.keys(doc.actions || {}), ...Object.keys(doc.gets || {}), ...(doc.params || [])];

  // uuid fields to auto-fill per query, so mock/source rows don't need to carry ids.
  const queryUuids: { [query: string]: string[] } = {};
  for (const def of Object.values(state)) {
    if (typeof def.source === 'string' && def.source.startsWith('query:')) {
      const query = def.source.slice('query:'.length);
      const elem = (def.type.match(/^list<(.+)>$/) || [])[1];
      queryUuids[query] = elem ? logic.uuidFields(elem) : [];
    }
  }

  // host-written Custom components, inlined (each exposes `mount(el, props, on)`). Wrapped in an
  // IIFE, so `export` keywords are stripped: `export function mount` inside a function would be
  // an illegal export and break the whole module (blank page).
  // A Custom with imports of its own (CUSTOM_MODULE) is imported instead: `import { mount as __custom_X } from "…"`.
  const inlined = Object.entries(components).filter(([, src]) => !src.startsWith(CUSTOM_MODULE));
  const moduleCustoms = Object.entries(components).filter(([, src]) => src.startsWith(CUSTOM_MODULE));
  const reactHelpers = (doc.imports || []).some((def) => def.kind === UseKind.React) ? REACT_HELPERS + '\n\n  ' : '';   // react-tree.ts
  const scripts = scriptGlobals(doc.imports);   // `use google from script "https://…"` (foreign.ts)
  const componentDecls = reactHelpers + inlined.map(([name, src]) =>
    `const __custom_${name} = (function () {\n${src.replace(/^[ \t]*export[ \t]+(default[ \t]+)?/gm, '')}\n  return mount;\n  })();`).join('\n\n  ');

  // import only the store domains actually referenced (collected in ctx.usedStores).
  const storeImports = [...usedStores].map((domain) => `import * as __store_${domain} from 'virtual:muten/store/${domain}';`).join('\n');

  // `use a, b from "./lib.ts"` -> real ESM import of named JS functions (the seam to the JS ecosystem).
  const externImports = [...(doc.imports || []).map(foreignImport),
    ...moduleCustoms.map(([name, src]) => `import { mount as __custom_${name} } from ${JSON.stringify(src.slice(CUSTOM_MODULE.length))};`),
    ...((doc.imports || []).some((def) => def.kind === UseKind.React) ? [REACT_RUNTIME] : [])].join('\n');

  // page <head> meta: title/description from the `meta` block; og:* auto-derived from them (one source).
  const metaIn = doc.meta || {};
  const meta: { [k: string]: string } = { ...metaIn };
  if (metaIn.title && !meta['og:title']) meta['og:title'] = metaIn.title;
  if (metaIn.description && !meta['og:description']) meta['og:description'] = metaIn.description;

  const parts: EmitParts = {
    screen, projectCss, data, sources, api: opts.api || {}, meta, queryUuids,
    stateDecls: opts.format === Fmt.Patch ? stateDecls : (scripts ? scripts + '\n  ' : '') + textTable + stateDecls, paramDecls, actionDecls, getDecls, effectDecls, componentDecls, storeImports, storeDecls: (opts.storeCode || '') + (opts.routeGuard ? `\nif (!(${opts.routeGuard.check})) { location.replace(${JSON.stringify(opts.routeGuard.redirect)}); await new Promise(() => {}); }` : ''), externImports,
    renderBody: (opts.format === Fmt.Patch ? textTable : '') + renderBody + imageWatch, staticHtml: staticHtml ?? '', hasSlot, ctxNames, dev: !!opts.dev,
    storeDomain: opts.format === Fmt.Store ? opts.persistScope : undefined,
  };
  const out = opts.format === Fmt.Patch ? emitPatch(parts, opts.patchRoot ?? '')   // HMR: one node's subtree as a (ctx, nodes, parent) builder
    : opts.format === Fmt.Store ? emitStore(parts)
    : opts.format === Fmt.Ssr ? emitSsr(parts)                                  // build-time pre-render factory (runs against a fake DOM)
    : staticPage ? (opts.format === Fmt.Module ? emitStatic(parts) : emitStaticHtml(parts))
    : opts.format === Fmt.Module ? emitModule(parts)
    : emitHtml(parts);
  // collapse the blank-line gaps an empty section (`${parts.getDecls}`, the prelude, …) leaves when interpolated.
  const final = out.replace(/\n[ \t]*\n([ \t]*\n)+/g, '\n\n');
  // append the source map (scanned from the FINAL text) so runtime errors point at the .muten line, not the JS.
  return opts.sourceMap ? final + inlineSourceMap(final, doc, opts.sourceMap.file, opts.sourceMap.source) : final;
}
