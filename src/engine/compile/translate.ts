// translate.ts: `t("key", …)`, the app's texts from src/lang/<code>.lang (project/lang-files.ts).
// Each page carries a table of only the keys it uses (compile.ts emits `__T`); a key built at run time
// (`t("plan.{tier}")`) brings every key that fits its pattern. The lookup itself is runtime-lang.ts's __t.
// Consumed by logic.ts only.

import { keyParts, keyPattern } from '#engine/ir/translate-check.js';
import { frozenValue } from '#engine/compile/frozen.js';
export { freeze } from '#engine/compile/frozen.js';
import type { CompileCtx, Expr, Scope } from '#engine/shared/types.js';

/** `t("login.email")` / `t("plan.left", used, cap)` → `__t(<language>, __T, key, …values)`, recording the key it needs.
 *  The language is the page's `lang from <expr>` when it has one, else the app's (`lang.current`). */
export function translateCall(ctx: CompileCtx, args: Expr[], compileExpr: (expr: Expr, scope?: Scope) => string): string {
  const [key, ...values] = args;
  if (key) {
    const parts = keyParts(key, (name) => frozenValue(ctx, name));   // `who.{kind}.h1` with a `kind` nothing writes: one key
    if (parts.every((part) => part !== null)) ctx.tKeys.add(parts.join(''));
    else { const pattern = keyPattern(parts); if (pattern) ctx.tPatterns.push(pattern); }
  }
  const language = ctx.langFrom ? compileExpr(ctx.langFrom, { locals: new Set() }) : '__lang().get()';
  return `__t(${language}, __T, ${[key, ...values].map((arg) => (arg ? compileExpr(arg) : '""')).join(', ')})`;
}

/** `const __T = {…}; __langInit([…]);` for a page that called t(): each language with only the keys it named (plus
 *  every key a run-time key's pattern fits). Empty when the app has no src/lang. */
export function speakTable(ctx: CompileCtx): string {
  const translations = ctx.translations;
  if (!translations) return '';
  const init = `__langInit(${JSON.stringify(Object.keys(translations))});\n  `;   // a language switcher with no t() still lists them
  if (!ctx.tKeys.size && !ctx.tPatterns.length) return init;
  const wanted = (key: string): boolean => ctx.tKeys.has(key) || ctx.tPatterns.some((pattern) => pattern.test(key));
  const table: { [code: string]: { [key: string]: string } } = {};
  for (const [code, texts] of Object.entries(translations)) table[code] = Object.fromEntries(Object.entries(texts).filter(([key]) => wanted(key)));
  return `const __T = ${JSON.stringify(table)};\n  ` + init;
}
