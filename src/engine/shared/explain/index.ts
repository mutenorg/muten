// explain: every code a finding can carry, explained, for `muten explain <code>` (and an agent that reads one).

import { NODES } from '#engine/shared/explain/nodes.js';
import { DATA } from '#engine/shared/explain/data.js';
import { PROJECT } from '#engine/shared/explain/project.js';
import type { Explanation, Explanations } from '#engine/shared/types-explain.js';

export const EXPLANATIONS: Explanations = { ...NODES, ...DATA, ...PROJECT };

/** The explanation of `code`, printed for a reader. */
export function explain(code: string): string | null {
  const entry: Explanation | undefined = EXPLANATIONS[code];
  if (!entry) return null;
  return [`${code}\n`, `  ${entry.means}`, `\n  Fix: ${entry.fix}`, ...(entry.wrong ? [`\n  ✗ ${entry.wrong}`] : []), ...(entry.right ? [`  ✓ ${entry.right}`] : [])].join('\n');
}
