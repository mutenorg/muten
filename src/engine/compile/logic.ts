// logic.ts: the behaviour half of the compiler (no DOM).
// Turns IR state/actions/effects into JS: reference resolution, expressions, action statements,
// and state/action/effect declarations. Shares one CompileCtx with compile.ts, so usedStores
// collected here becomes store imports there. Consumed by compile.ts only.

import { Ek, StOp, BOp, UOp, Fmt } from '#engine/shared/vocab.js';
import { JS_BINOP } from '#engine/compile/helpers.js';
import { listElementFields, type RefFacts } from '#engine/ir/refs.js';
import type { CompileCtx, Expr, Stmt, Scope, Value, ValueObject } from '#engine/shared/types.js';

export class Logic {
  constructor(private readonly ctx: CompileCtx) {}

  // ── reference resolution ──────────────────────────────────────────────────

  // is `member` a `kind` member (state | gets | actions) of the store domain `d`?
  private inStore(d: string, member: string, kind: 'state' | 'gets' | 'actions'): boolean {
    const slice = this.ctx.stores[d];
    return !!slice && (slice[kind] || []).includes(member);
  }

  // ctx-refs mode (HMR patch builders only): a re-built node reads state/actions/gets/params through the LIVE
  // `ctx` object instead of mount-closure locals, so it binds to the SAME signals. Off in the main module.
  private cx(name: string): string { return this.ctx.ctxRefs ? 'ctx.' + name : name; }

  // action name -> its callable. Store action `cart.add` -> `__store_cart.add` (domain marked used);
  // local action stays as written; missing name compiles to nothing.
  actionRef(name: string | undefined): string {
    if (!name) return '';
    const [domain, member] = name.split('.');
    if (member && this.inStore(domain, member, 'actions')) { this.ctx.usedStores.add(domain); return `__store_${domain}.${member}`; }
    return this.cx(name);
  }

  // bind/data target -> signal name. `@local` -> `local`; `cart.query` -> `__store_cart.query`.
  // validate has already guaranteed the bind exists.
  bindSig(ref: string | undefined): string {
    if (typeof ref !== 'string') return '';
    const bare = ref.startsWith('@') ? ref.slice(1) : ref; // `@rows` and `rows` bind the same signal
    const [domain, field] = bare.split('.');
    if (field && this.ctx.stores[domain]) { this.ctx.usedStores.add(domain); return `__store_${domain}.${field}`; } // `@orders.items` / `orders.items` -> the store's exported signal
    return bare;
  }

  // `bind(row.field)` where `row` is a keyed-each row var: the input two-way-binds to a list element.
  // Reads the row signal; writes by patching the source list state (inline-editable list items / dynamic
  // forms). null for a normal state/store bind. `src` is undefined when the each iterates a non-settable
  // list (a query / derived list) -> the binding is read-only (no write-back).
  private itemBind(ref: string | undefined, scope: Scope): { row: string; field: string; src?: string } | null {
    if (typeof ref !== 'string' || !scope.sigLocals) return null;
    const [row, field] = ref.replace(/^@/, '').split('.');
    if (!field || !scope.sigLocals.has(row)) return null;
    return { row, field, src: scope.itemBinds?.[row] };
  }

  // JS expression reading the current bound value (state / store field / each-item field).
  bindRead(ref: string | undefined, scope: Scope): string {
    const it = this.itemBind(ref, scope);
    if (it) return `${it.row}.get()[${JSON.stringify(it.field)}]`;
    return `${this.bindSig(ref)}.get()`;
  }

  // JS statement persisting `valJs` to the bound target. '' when the bind is read-only (each-item over a
  // non-settable list) — the caller then marks the control read-only rather than wiring a dead listener.
  bindWrite(ref: string | undefined, scope: Scope, valJs: string): string {
    const it = this.itemBind(ref, scope);
    if (it) {
      if (!it.src) return '';
      const s = this.cx(it.src);   // patch the matching element immutably so the keyed `each` reconciles just that row
      return `${s}.set((${s}.get() || []).map((__r) => __r && __r.id === ${it.row}.get().id ? { ...__r, [${JSON.stringify(it.field)}]: ${valJs} } : __r))`;
    }
    return `${this.bindSig(ref)}.set(${valJs})`;
  }

  // uuid fields of an entity: auto-filled whenever an item is pushed onto a list<Entity>.
  uuidFields(entityName: string): string[] {
    const entity = this.ctx.entities[entityName] || {};
    return Object.entries(entity).filter(([, type]) => type === 'uuid').map(([field]) => field);
  }

  // the SHARED resolver's inputs — the SAME facts the linter holds (engine/ir/refs.ts), so what a list
  // resolves to can never drift between lint and runtime (the old two-layer ReferenceError bug).
  private get refFacts(): RefFacts { return { state: this.ctx.state, gets: this.ctx.gets, entities: this.ctx.entities, storeEntities: this.ctx.storeEntities }; }

  // bare-referenceable fields of `<list>`'s element, for a `where`/`by` item-implicit scope — via the
  // SHARED resolver, so the linter and the emitter agree on exactly which fields a row exposes
  // (`tasks : list<Task>` -> { id, ...Task fields }; a non-entity element (list<uuid>) -> just `id`).
  private itemFields(list: string): Set<string> {
    return listElementFields(list, this.refFacts);
  }

  // does the body contain a server write (create/update/delete)? recurses into if-branches.
  private bodyHasWrite(body: Stmt[]): boolean {
    return body.some((st) => st.op === StOp.Create || st.op === StOp.Update || st.op === StOp.Delete || st.op === StOp.Request
      || (st.op === StOp.If && (this.bodyHasWrite(st.then || []) || this.bodyHasWrite(st.else || []))));
  }
  // write actions become async and expose live `.pending` / `.error` signals. Memoized.
  private writeActionsSet: Set<string> | null = null;
  private writeActions(): Set<string> {
    if (!this.writeActionsSet) this.writeActionsSet = new Set(Object.entries(this.ctx.actions).filter(([, a]) => this.bodyHasWrite(a.body || [])).map(([n]) => n));
    return this.writeActionsSet;
  }

  // dotted reference -> runtime JS, honouring scope:
  // where/by item field stays bare; query reads `.data` (or `.loading`/`.error`); local state reads `.get()`;
  // store member reads through its module; const inlines; else passes through as an action param.
  resolveRef(name: string, scope: Scope): string {
    const [head, ...rest] = name.split('.');
    const tail = rest.length ? '.' + rest.join('.') : '';
    if (scope.sigLocals?.has(head)) return `${head}.get()${tail}`;   // keyed-each row signal: bindings react to the row's data
    if (scope.locals.has(head)) return head + tail;
    if (scope.item?.fields.has(head)) return `${scope.item.var}.${name}`;   // `<list> where <cond>`: bare field of the item, read off the row

    if (this.ctx.params.has(head)) return this.cx(head) + tail;        // route param: local string injected at mount
    if (this.ctx.queryStates.has(head)) {
      if (rest[0] === 'loading' || rest[0] === 'error' || rest[0] === 'data') return `${head}.get()${tail}`; // .loading/.error/.data are the signal's own fields, no double .data
      return `${head}.get().data${tail}`;                 // @users -> data array; @users.length -> its length
    }
    if (this.ctx.stateKeys.has(head)) return `${this.cx(head)}.get()` + (rest.length ? '?.' + rest.join('?.') : ''); // optional-chain nested entity access: `{o.inner.name}` on `o = {} : Entity` must not throw on the empty record
    if (this.ctx.gets[head] !== undefined) return `${this.cx(head)}.get()` + (rest.length ? '?.' + rest.join('?.') : ''); // `get` is a computed signal, read like state
    if (this.ctx.stores[head]) {
      const member = rest[0];
      const more = rest.length > 1 ? '.' + rest.slice(1).join('.') : '';
      if (this.inStore(head, member, 'state') || this.inStore(head, member, 'gets')) {
        this.ctx.usedStores.add(head);
        // a store query member holds { data, loading, error } — a BARE ref unwraps to its .data array (same as a page
        // query, lines above), so `each store.q as x` iterates rows, not the wrapper. `.data/.loading/.error` pass through.
        const sub = rest[1];
        if ((this.ctx.stores[head]?.queries || []).includes(member) && sub !== 'data' && sub !== 'loading' && sub !== 'error') return `__store_${head}.${member}.get().data${more}`;
        return `__store_${head}.${member}.get()${more}`;
      }
      // a store WRITE action's live status: `orders.place.pending` / `.error` -> the store's exported __pending_/__error_
      // signal. Without this the ref fell through to a bare `orders` (undefined at runtime — a documented-but-crashing pattern).
      if ((rest[1] === 'pending' || rest[1] === 'error') && this.inStore(head, member, 'actions')) { this.ctx.usedStores.add(head); return `__store_${head}.${rest[1] === 'pending' ? '__pending_' : '__error_'}${member}.get()`; }
    }
    if (this.ctx.consts[head] !== undefined) return JSON.stringify(rest.length ? null : this.ctx.consts[head]); // scalar const: inlined
    if (this.writeActions().has(head) && (rest[0] === 'pending' || rest[0] === 'error')) { // write action's live status
      return `${rest[0] === 'pending' ? '__pending_' : '__error_'}${head}.get()`;
    }
    return head + tail;                                    // action input parameter (e.g. id)
  }

  // ── expressions ──────────────────────────────────────────────────────────

  // expression AST -> JS string. Recursive; precedence is baked into the tree.
  compileExpr(node: Expr, scope: Scope): string {
    if (node.kind === Ek.Lit) return JSON.stringify(node.value);
    if (node.kind === Ek.Ref) return this.resolveRef(node.name, scope);
    if (node.kind === Ek.Call) return `${node.fn}(${node.args.map((a) => this.compileExpr(a, scope)).join(', ')})`; // use'd JS function
    if (node.kind === Ek.Obj) return `{ ${node.fields.map((f) => `${JSON.stringify(f.key)}: ${this.compileExpr(f.value, scope)}`).join(', ')} }`; // inline object literal
    if (node.kind === Ek.Agg) { // `list.sum by expr` / `list.count where cond` -> reduce/filter; item fields read bare off `__it`
      const list = `(${this.resolveRef(node.list, scope)} ?? [])`;
      if (node.op === 'take') return `[...${list}].slice(0, ${this.compileExpr(node.body, scope)})`; // `list.take(n)` -> first n items (the count reads no item fields)
      if (node.op === 'at') return `(${list}).at(${this.compileExpr(node.body, scope)})${node.member ? '?.' + node.member : ''}`; // `list.at(n)[.field]` -> the element at n (out of range -> undefined; `?.` keeps a field read safe)
      const body = this.compileExpr(node.body, { ...scope, item: { var: '__it', fields: this.itemFields(node.list) } });
      if (node.op === 'sort' || node.op === 'sortDesc') { // sort a copy by projected key (no mutation of the source signal)
        const dir = node.op === 'sortDesc' ? -1 : 1;
        const itemF = this.itemFields(node.list);
        // a key that is a bare ref to something OTHER than a row field (a state/get/const) names the column
        // DYNAMICALLY at runtime: `each rows.sort by sortCol` with sortCol = "price" -> sort by __it["price"].
        // (A user-chosen sort column — the realistic sortable-table need. A literal row field stays static.)
        const b = node.body;
        const dyn = b.kind === Ek.Ref && !b.name.includes('.') && b.name !== 'id' && itemF.size > 0 && !itemF.has(b.name);
        const key = dyn && b.kind === Ek.Ref ? `((__it) => __it[${this.resolveRef(b.name, scope)}])` : `((__it) => ${body})`;
        const sorted = `[...${list}].sort((__a, __b) => { const __ka = ${key}(__a), __kb = ${key}(__b); return (__ka < __kb ? -1 : __ka > __kb ? 1 : 0) * ${dir}; })`;
        return node.take ? `${sorted}.slice(0, ${this.compileExpr(node.take, scope)})` : sorted; // `sort by … take(n)` -> top-n after sorting
      }
      const reduce = (init: string, step: string): string => `${list}.reduce((__a, __it) => ${step}, ${init})`;
      if (node.op === 'count') return `${list}.filter((__it) => ${body}).length`;
      if (node.op === 'sum') return reduce('0', `__a + (${body})`);
      if (node.op === 'avg') return `(${reduce('0', `__a + (${body})`)} / (${list}.length || 1))`;
      // min/max guard the empty list: return 0, not ±Infinity (which renders as garbage)
      if (node.op === 'min') return `(${list}.length ? ${reduce('Infinity', `Math.min(__a, ${body})`)} : 0)`;
      return `(${list}.length ? ${reduce('-Infinity', `Math.max(__a, ${body})`)} : 0)`; // max: same empty-list guard
    }
    if (node.kind === Ek.Filter) { // derived list `<list> where <cond>` -> filter a copy; bare fields off the row (item-implicit)
      const list = `[...(${this.resolveRef(node.list, scope)} ?? [])]`;
      const cond = this.compileExpr(node.cond, { ...scope, item: { var: '__it', fields: this.itemFields(node.list) } });
      return `${list}.filter((__it) => ${cond})`;
    }
    if (node.kind === Ek.Tern) return `(${this.compileExpr(node.cond, scope)} ? ${this.compileExpr(node.then, scope)} : ${this.compileExpr(node.else, scope)})`;
    if (node.kind === Ek.Un) {
      if (node.op === UOp.Not) return `!(${this.compileExpr(node.operand, scope)})`;
      throw new Error('unsupported unary operator');
    }
    if (node.kind === Ek.Bin) {
      const left = this.compileExpr(node.left, scope);
      const right = this.compileExpr(node.right, scope);
      if (node.op === BOp.Contains) return `__has(${left}, ${right})`; // list membership or substring
      const js = JS_BINOP[node.op];
      if (js) return `(${left} ${js} ${right})`;
      throw new Error('unsupported operator: ' + node.op);
    }
    throw new Error('unsupported expression');
  }

  // ── action statements ─────────────────────────────────────────────────────

  // one mutation statement (action body or .store effect) -> JS line(s). `if` recurses.
  stmtLines(st: Stmt, scope: Scope, isAsync = false): string[] {
    const ctx = this.ctx;
    const out: string[] = [];
    // Belt-and-suspenders: the LOCAL mutation ops dereference ctx.state[target]. Validate rejects a store/undeclared target,
    // but if compile ever runs on lint-unclean input, fail with a CLEAR message instead of a cryptic `undefined.type` crash.
    if ('target' in st && st.target && (st.op === StOp.Push || st.op === StOp.Reset || st.op === StOp.Patch || st.op === StOp.Remove || st.op === StOp.Toggle) && !ctx.state[st.target]) {
      throw new Error(`cannot \`${st.op}\` "${st.target}" — it is not a page-local state (a store is mutated via a store action, e.g. ${st.target}.add(…)).`);
    }
    switch (st.op) {
      case StOp.If: {
        out.push(`if (${this.compileExpr(st.cond, scope)}) {`);
        for (const s of st.then || []) for (const l of this.stmtLines(s, scope, isAsync)) out.push('  ' + l);
        if (st.else) { out.push('} else {'); for (const s of st.else) for (const l of this.stmtLines(s, scope, isAsync)) out.push('  ' + l); }
        out.push('}');
        break;
      }
      case StOp.Reset:
        out.push(`${st.target}.set(${JSON.stringify(ctx.state[st.target].initial ?? null)});`);
        break;
      case StOp.Toggle:
        if (st.arg !== undefined) { // list<scalar> membership: present -> remove, absent -> add (the toggle-OFF a scalar `remove` can't do)
          const v = this.compileExpr(st.arg, scope);
          out.push(`{ const __v = ${v}, __l = ${st.target}.get(); ${st.target}.set(__l.includes(__v) ? __l.filter((__e) => __e !== __v) : [...__l, __v]); }`);
        } else out.push(`${st.target}.set(!${st.target}.get());`); // boolean flip
        break;
      case StOp.Set:
        out.push(`${st.target}.set(${this.compileExpr(st.arg, scope)});`);
        break;
      case StOp.Push: {
        const elem = (ctx.state[st.target].type.match(/^list<(.+)>$/) || [])[1];
        const isEntity = elem && ctx.entities[elem]; // list<User> -> entity; list<uuid>/list -> scalar
        // query-backed target carries { data, loading, error }, so splice into `.data`, not the signal.
        const wrap = (value: string): string => ctx.queryStates.has(st.target)
          ? `${st.target}.set({ ...${st.target}.get(), data: [...${st.target}.get().data, ${value}] });`
          : `${st.target}.set([...${st.target}.get(), ${value}]);`;
        if (isEntity) { // entity list: copy item + auto-fill uuid fields
          out.push(`{ const __it = { ...${this.compileExpr(st.arg, scope)} };`);
          for (const field of this.uuidFields(elem)) out.push(`  if (__it.${field} === null || __it.${field} === undefined) __it.${field} = __id();`);
          out.push(`  ${wrap('__it')} }`);
        } else { // scalar list (ids, numbers): push value as-is
          out.push(`${wrap(this.compileExpr(st.arg, scope))}`);
        }
        break;
      }
      case StOp.Remove: {
        const inner: Scope = { ...scope, item: { var: '__it', fields: this.itemFields(st.target) } }; // `remove where ...`: bare fields off __it
        const pred = this.compileExpr(st.pred, inner);
        out.push(ctx.queryStates.has(st.target)
          ? `${st.target}.set({ ...${st.target}.get(), data: ${st.target}.get().data.filter((__it) => !(${pred})) });`
          : `${st.target}.set(${st.target}.get().filter((__it) => !(${pred})));`);
        break;
      }
      case StOp.Patch: {
        // in-place edit: map the list, merging patch into matched items. `.map` keeps order
        // and `{ ...item, ...patch }` overwrites only the listed fields (no drop).
        const inner: Scope = { ...scope, item: { var: '__it', fields: this.itemFields(st.target) } }; // `patch where ... with ...`: bare fields off __it
        const pred = this.compileExpr(st.pred, inner);
        const patch = this.compileExpr(st.patch, inner);
        const mapped = (src: string): string => `${src}.map((__it) => (${pred}) ? { ...__it, ...${patch} } : __it)`;
        out.push(ctx.queryStates.has(st.target)
          ? `${st.target}.set({ ...${st.target}.get(), data: ${mapped(`${st.target}.get().data`)} });`
          : `${st.target}.set(${mapped(`${st.target}.get()`)});`);
        break;
      }
      case StOp.Create:
      case StOp.Update:
      case StOp.Delete: {
        // server CRUD on a source-backed list: POST/PUT/DELETE, then reflect the change locally.
        const isQuery = ctx.queryStates.has(st.target);
        const cur = isQuery ? `${st.target}.get().data` : `${st.target}.get()`;
        const set = (data: string): string => isQuery ? `${st.target}.set({ ...${st.target}.get(), data: ${data} })` : `${st.target}.set(${data})`;
        const err = isQuery ? `.catch((__e) => ${st.target}.set({ ...${st.target}.get(), error: String(__e) }))` : '';
        const name = JSON.stringify(st.target);
        const value = this.compileExpr(st.arg, scope);
        if (isAsync) { // optimistic: apply now (instant UI), reconcile on success, revert on failure
          if (st.op === StOp.Create) out.push(`{ const __i = { ...${value} }; if (__i.id == null) __i.id = __id(); const __prev = ${cur}; ${set(`[...__prev, __i]`)}; try { const __r = await __write(${name}, 'POST', null, __i); ${set(`${cur}.map((__x) => __x.id === __i.id ? __r : __x)`)}; } catch (__e) { ${set('__prev')}; throw __e; } }`);
          else if (st.op === StOp.Update) out.push(`{ const __i = ${value}; const __prev = ${cur}; ${set(`__prev.map((__x) => __x.id === __i.id ? __i : __x)`)}; try { const __r = await __write(${name}, 'PUT', __i.id, __i); ${set(`${cur}.map((__x) => __x.id === __i.id ? __r : __x)`)}; } catch (__e) { ${set('__prev')}; throw __e; } }`);
          else out.push(`{ const __i = ${value}; const __prev = ${cur}; ${set(`__prev.filter((__x) => __x.id !== __i.id)`)}; try { await __write(${name}, 'DELETE', __i.id, null); } catch (__e) { ${set('__prev')}; throw __e; } }`);
        } else { // fire-and-forget (e.g. inside a .store effect): reflect on resolve, set error on failure
          if (st.op === StOp.Create) out.push(`{ const __i = ${value}; __write(${name}, 'POST', null, __i).then((__r) => ${set(`[...${cur}, __r]`)})${err}; }`);
          else if (st.op === StOp.Update) out.push(`{ const __i = ${value}; __write(${name}, 'PUT', __i.id, __i).then((__r) => ${set(`${cur}.map((__x) => __x.id === __i.id ? __r : __x)`)})${err}; }`);
          else out.push(`{ const __i = ${value}; __write(${name}, 'DELETE', __i.id, null).then(() => ${set(`${cur}.filter((__x) => __x.id !== __i.id)`)})${err}; }`);
        }
        break;
      }
      case StOp.Refetch: {
        // re-run a query with new query-string params (pagination/search/filters) and update its signal.
        const pairs = Object.entries(st.params).map(([k, e]) => `${JSON.stringify(k)}: ${this.compileExpr(e, scope)}`).join(', ');
        out.push(`__refetch(${JSON.stringify(st.target)}, { ${pairs} }, ${st.target});`);
        break;
      }
      case StOp.Request: {
        // non-REST request escape hatch: build the url (with interpolation) and send the optional body.
        const url = typeof st.url === 'string' ? JSON.stringify(st.url)
          : st.url.parts.map((p) => typeof p === 'string' ? JSON.stringify(p) : `String(${this.compileExpr(p, scope)})`).join(' + ');
        const body = st.body ? this.compileExpr(st.body, scope) : 'null';
        const send = `__send(${url}, ${JSON.stringify(st.method)}, ${body})`;
        if (st.into) out.push(isAsync ? `${st.into}.set(await ${send});` : `${send}.then((__r) => ${st.into}.set(__r)).catch(() => {});`); // capture the JSON response into a local state
        else out.push(isAsync ? `await ${send};` : `${send}.catch(() => {});`);
        break;
      }
      case StOp.Call:
        // page action calling a store action: `shop.addProduct(draft)` -> call the imported store fn.
        this.ctx.usedStores.add(st.target);
        out.push(`__store_${st.target}.${st.method}(${st.args.map((a) => this.compileExpr(a, scope)).join(', ')});`);
        break;
      case StOp.Extern:
        // calling a use'd function as a side-effect: `persist(messages)` -> the imported fn, args compiled like any expr.
        out.push(`${st.fn}(${st.args.map((a) => this.compileExpr(a, scope)).join(', ')});`);
        break;
    }
    return out;
  }

  // ── declarations (state / action / effect) ───────────────────────────────

  // declared state -> `signal(initial)` or `query(name)`. Exported for a .store slice.
  genState(): string {
    const exp = this.ctx.format === Fmt.Store ? 'export ' : '';
    const out: string[] = [];
    for (const [name, def] of Object.entries(this.ctx.state)) {
      if (typeof def.source === 'string' && def.source.startsWith('query:')) {
        out.push(`${exp}const ${name} = query(${JSON.stringify(def.source.slice('query:'.length))}${def.live ? ', true' : ''});`);
      } else {
        let initial: Value = def.initial ?? null;
        const elem = def.type.startsWith('list<') ? def.type.slice(5, -1) : '';
        const uuids = elem ? this.uuidFields(elem) : [];
        if (uuids.length && Array.isArray(initial)) {
          // seed rows need a stable id too: `push` auto-mints one but seeds didn't, so remove/update
          // by id matched `undefined == undefined` (one move hit every row). Fill deterministically
          // at compile-time so SSR and CSR agree (a runtime __id() would mismatch on hydration).
          initial = initial.map((row, i): Value => {
            if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
            const o: ValueObject = { ...row };
            for (const f of uuids) if (o[f] === null || o[f] === undefined) o[f] = `${name}-${i}`;
            return o;
          });
        }
        if (def.persist) { // localStorage-backed: hydrate from storage (fallback to the declared initial), save on every change
          // namespace by scope (store domain / page screen) so two stores with the same state name (`items`)
          // don't share ONE localStorage key — the silent cross-store data bleed.
          const key = JSON.stringify('muten:' + this.ctx.persistScope + ':' + name);
          out.push(`${exp}const ${name} = signal(__loadLocal(${key}, ${JSON.stringify(initial)}));`);
          out.push(`effect(() => __saveLocal(${key}, ${name}.get()));`);
        } else {
          out.push(`${exp}const ${name} = signal(${JSON.stringify(initial)});`);
        }
      }
    }
    return out.join('\n  ');
  }

  // declared actions -> functions. An action whose input names a state reads it directly (no param).
  // Exported for a .store slice so pages can import them.
  genActions(): string {
    const exp = this.ctx.format === Fmt.Store ? 'export ' : '';
    const decls: string[] = []; // .pending/.error signals for write actions, hoisted above the fns
    const out: string[] = [];
    for (const [name, action] of Object.entries(this.ctx.actions)) {
      // multi-param form `action f(a: T, b: T)`: params become the signature AND scope locals,
      // so refs resolve bare and shadow state. Else fall back to the legacy `<- input` path.
      const hasParams = !!action.params?.length;
      const inputIsState = !hasParams && this.ctx.stateKeys.has(action.input);
      const scope: Scope = hasParams
        ? { locals: new Set(action.params!.map((p) => p.name)) }
        : { locals: new Set(), input: action.input, inputIsState };
      const param = hasParams ? action.params!.map((p) => p.name).join(', ') : inputIsState ? '' : action.input;
      // dev: announce the action to the DevTools so the History labels it by NAME (app-fired actions can't be
      // intercepted post-mount — handlers call this local fn, not ctx[name] — so the compiler emits the hook).
      const announce = this.ctx.dev ? `if (typeof window !== 'undefined' && window.__muten_rt && window.__muten_rt.__dispatch) window.__muten_rt.__dispatch(${JSON.stringify(name)});` : '';
      if (this.writeActions().has(name)) { // backend write -> async, with live .pending / .error
        decls.push(`${exp}const __pending_${name} = signal(false);`, `${exp}const __error_${name} = signal(null);`);
        out.push(`${exp}async function ${name}(${param}) {`);
        if (announce) out.push('  ' + announce);
        out.push(`  __pending_${name}.set(true); __error_${name}.set(null);`);
        out.push('  try {');
        for (const st of action.body || []) for (const l of this.stmtLines(st, scope, true)) out.push('    ' + l);
        out.push(`  } catch (__e) { __error_${name}.set(String(__e)); }`);
        out.push(`  __pending_${name}.set(false);`);
        out.push('}');
      } else {
        out.push(`${exp}function ${name}(${param}) {`);
        if (announce) out.push('  ' + announce);
        for (const st of action.body || []) for (const l of this.stmtLines(st, scope)) out.push('  ' + l);
        out.push('}');
      }
    }
    return [...decls, ...out].join('\n  ');
  }

  // .store reactive side-effects -> effect(() => { ... }), re-running when the state they read changes.
  genEffects(): string {
    const scope: Scope = { locals: new Set() };
    return this.ctx.effects.map((body) =>
      `effect(() => {\n${body.map((st) => this.stmtLines(st, scope).map((l) => '    ' + l).join('\n')).join('\n')}\n  });`).join('\n  ');
  }
}
