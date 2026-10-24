// types-explain: the shape of `muten explain`'s catalog (engine/shared/explain/).

/** What a finding's code means, for `muten explain <code>`: in a sentence, how to fix it, and the slip next to its fix. */
export interface Explanation {
  means: string;
  fix: string;
  wrong?: string;
  right?: string;
}
/** Every code a finding can carry, explained (engine/shared/explain/). */
export interface Explanations { [code: string]: Explanation }
