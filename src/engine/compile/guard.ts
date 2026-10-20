// guard: a route guard (`guard auth.signedIn and not auth.blocked else "/login"`) -> the JS the router calls on every
// navigation. A guard reads only store members (check-app.ts proves it), so each ref is a store signal read; the
// domains it touches come back too, so the boot module imports exactly those stores.
import type { Expr } from '#engine/shared/types.js';
import { Ek, UOp, BOp } from '#engine/shared/vocab.js';
import { JS_BINOP } from '#engine/compile/helpers.js';

export function guardJs(guard: Expr, domains: Set<string>): string {
  switch (guard.kind) {
    case Ek.Lit: return JSON.stringify(guard.value);
    case Ek.Ref: {
      const [domain, member, ...rest] = guard.name.split('.');
      domains.add(domain);
      return `__store_${domain}.${member}.get()${rest.map((field) => `?.${field}`).join('')}`;
    }
    case Ek.Un: return guard.op === UOp.Not ? `!(${guardJs(guard.operand, domains)})` : 'false';
    case Ek.Bin: {
      const op = guard.op === BOp.Contains ? null : JS_BINOP[guard.op];
      return op ? `(${guardJs(guard.left, domains)} ${op} ${guardJs(guard.right, domains)})` : 'false';
    }
    case Ek.Tern: return `(${guardJs(guard.cond, domains)} ? ${guardJs(guard.then, domains)} : ${guardJs(guard.else, domains)})`;
    default: return 'false';   // a call/list op in a guard: check-app rejects it; closed is the safe default
  }
}
