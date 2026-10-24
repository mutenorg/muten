// runtime-pure: runtime helpers that touch nothing of the browser, so the native output (native-project.ts) can take
// them without the rest of runtime.ts, whose modules reach for the DOM as they load (a drag-and-drop listener on
// window: on React Native, where window has no addEventListener, the app crashed on open).

// `a contains b`: list membership or case-insensitive substring, one operator for both.
export function __has<T>(a: readonly T[] | string | null | undefined, b: T): boolean {
  if (Array.isArray(a)) return a.includes(b);
  return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
}

let seq = 0;
export function __id(): string {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + (++seq);
}
