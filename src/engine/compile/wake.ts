// wake: the arguments an island's `__island(host, wake, …)` call gets from its `wake` modifier (runtime-island.ts):
// nothing for the default (visible), the mode otherwise, and the query for `wake media "(…)"`.
import type { NodeProps } from '#engine/shared/types.js';
import { WakeMode } from '#engine/shared/vocab.js';

/** ', "idle"' · ', "media", "(min-width: 800px)"' · '' (visible). */
export function wakeArgs(p: NodeProps): string {
  const wake = p.wake;
  if (!wake || wake.mode === WakeMode.Visible) return '';
  return `, ${JSON.stringify(wake.mode)}${wake.mode === WakeMode.Media ? `, ${JSON.stringify(wake.query || '')}` : ''}`;
}
