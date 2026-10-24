// translate-check: what `t("key", …)` can get wrong, checked against the app's src/lang/*.lang.
//   t("login.emial")        no language has that key (with the closest one that exists)
//   t("hello")              "Hola, {0}" fills a value the call does not pass
//   t("plan.{tier}")        a key built at run time that no key fits
// The key pieces are shared with the compiler (compile/translate.ts), which cuts each page's table by them.
import { diag, closest } from '#engine/shared/diagnostics.js';
import { Ek, BOp } from '#engine/shared/vocab.js';
import type { CallExpr, Diagnostic, Expr, Loc, Translations } from '#engine/shared/types.js';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const PLACEHOLDER = /\{(\d+)\}/g;
const PLURAL = ' | ';

/** A key as its literal pieces and the parts known only at run time (null): "a.b" → ["a.b"]; "post.{id}.fee" → ["post.", null, ".fee"]. */
export function keyParts(key: Expr, known: (name: string) => string | number | undefined = () => undefined): Array<string | null> {
  if (key.kind === Ek.Lit) return [typeof key.value === 'string' ? key.value : null];
  if (key.kind === Ek.Bin && key.op === BOp.Add) return [...keyParts(key.left, known), ...keyParts(key.right, known)];
  if (key.kind === Ek.Ref) { const value = known(key.name); return [value === undefined ? null : String(value)]; }   // a name whose value the compiler knows
  return [null];
}

/** The pattern a run-time key fits; one with no literal piece fits nothing (the check names it). */
export function keyPattern(parts: Array<string | null>): RegExp | null {
  if (!parts.some((part) => part)) return null;
  return new RegExp('^' + parts.map((part) => (part === null ? '.+' : part.replace(REGEX_SPECIAL, '\\$&'))).join('') + '$');
}

/** How many values a text fills: its highest {n} + 1, and at least one when it picks singular | plural by the first. */
export function valuesNeeded(text: string): number {
  let needed = text.includes(PLURAL) ? 1 : 0;
  for (const match of text.matchAll(PLACEHOLDER)) needed = Math.max(needed, Number(match[1]) + 1);
  return needed;
}

/** The diagnostic of one `t(…)` call, or null when it says something every language can answer. */
export function translateDiagnostic(call: CallExpr, loc: Loc | null, translations: Translations): Diagnostic | null {
  const [key, ...values] = call.args;
  const allKeys = [...new Set(Object.values(translations).flatMap((texts) => Object.keys(texts)))];
  if (!key) return diag('t-no-key', 't needs the key of a text: `t("login.email")`, written in src/lang/<code>.lang', { loc, from: call.fn });
  const parts = keyParts(key);
  if (parts.some((part) => part === null)) {
    const pattern = keyPattern(parts);
    if (pattern && allKeys.some((candidate) => pattern.test(candidate))) return null;
    const shown = parts.map((part) => part ?? '…').join('');
    return diag('t-unknown-key', pattern ? `no text fits the key "${shown}": src/lang has none that starts and ends like it` : 't builds its whole key at run time, so nothing can say which texts it needs: write the fixed part in quotes, `t("plan.{tier}")`', { loc, from: call.fn });
  }
  const name = parts.join('');
  const text = Object.values(translations).map((texts) => texts[name]).find((found) => found !== undefined);
  if (text === undefined) return diag('t-unknown-key', `no language has the text "${name}": add \`${name} "…"\` to src/lang/${Object.keys(translations).join('.lang, src/lang/')}.lang`, { loc, suggestion: closest(name, allKeys), from: call.fn });
  const needed = valuesNeeded(text);
  if (values.length < needed) return diag('t-values', `"${name}" is "${text}": it fills ${needed} value${needed === 1 ? '' : 's'}, and this call passes ${values.length}. Pass them after the key: t("${name}", ${Array.from({ length: needed }, (_, index) => `value${index}`).join(', ')})`, { loc, from: call.fn });
  if (values.length > needed) return diag('t-values', `"${name}" is "${text}": it fills ${needed} value${needed === 1 ? '' : 's'}, so the last ${values.length - needed} passed here never show`, { loc, from: call.fn, severity: 'warning' });
  return null;
}
