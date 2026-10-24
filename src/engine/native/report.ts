// report: the native output's gaps, each once with how many times it came up, most frequent first.
import type { NativeGap } from '#engine/shared/types-native.js';

export function countGaps(gaps: NativeGap[]): Array<NativeGap & { count: number }> {
  const seen = new Map<string, NativeGap & { count: number }>();
  for (const gap of gaps) {
    const key = `${gap.kind}|${gap.what}`;
    const known = seen.get(key);
    if (known) known.count++; else seen.set(key, { ...gap, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count);
}
