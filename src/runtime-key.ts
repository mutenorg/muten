// The key a list row (`each`) is matched by between two runs, so a row that did not change keeps its DOM.
// A row with an `id` is its id. A row WITHOUT one used to be the object itself: a list computed again (a `get` built
// by a `use` function, an `.map`, rows a server sends without ids) is all new objects with the same content, so
// every row was destroyed and rebuilt, its animations replayed and its hover lost: the app blinked on every change.
// It is matched by its CONTENT instead: equal rows keep their nodes and only the rows that really changed rebuild.
// Twin rows (same content twice) count up (#1, #2…) so each keeps its own place. Content that can't be serialized
// (a cycle) falls back to the object itself, as before.

const CONTENT_KEY = '\u0000row:';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type RowKey = Primitive | object;
interface RowWithId { readonly id?: RowKey }
/** A list row as `each` sees it: a plain value, or an object (with an `id` or not). */
export type Row = Primitive | RowWithId;

// A plain value (a number, a text) is its own key the first time; a repeat is a twin too. Keyed by the bare value,
// `[1, 1, 1, 0, 1]` drew two rows and `["x", "x", "y"]` drew `y, x`: the list behaved like a set.
const VALUE_KEY = '\u0000value:';

export function __rowKey(row: Row, twins: Map<string, number>): RowKey {
  if (row === null || typeof row !== 'object') {
    const content = `${typeof row}:${String(row)}`;
    const seen = twins.get(VALUE_KEY + content) ?? 0;
    twins.set(VALUE_KEY + content, seen + 1);
    return seen === 0 ? row : `${VALUE_KEY}${content}#${seen}`;
  }
  if (row.id !== undefined && row.id !== null) return row.id;
  let content: string;
  try { content = JSON.stringify(row); } catch { return row; }
  const seen = twins.get(content) ?? 0;
  twins.set(content, seen + 1);
  return seen === 0 ? CONTENT_KEY + content : `${CONTENT_KEY}${content}#${seen}`;
}
