// sizes: a size as muten.config writes it ("150kb", "1.5 mb", 150000), in bytes. Read by budget.ts and config-check.

const UNITS: { [unit: string]: number } = { b: 1, kb: 1024, mb: 1024 * 1024 };
const SIZE = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)?\s*$/i;

/** "150kb" / "1.5 mb" / 150000 → bytes, or undefined when it is not a size. */
export function parseSize(value: unknown): number | undefined {
  if (typeof value === 'number' && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const match = SIZE.exec(value);
  return match ? Number(match[1]) * UNITS[(match[2] || 'b').toLowerCase()] : undefined;
}
