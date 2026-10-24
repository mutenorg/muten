// reads: which of the page's data a node reads (its states, gets and store values), for the devtools' Inspect in
// `muten dev`. The compiler already holds every expression a node draws with (its text, its `when`, its `each`, its
// classes, the props it passes), so the answer is exact and costs the page nothing outside dev: the names a ref in any
// of them starts with, kept when they are data and not a row of an `each` or an action's param.
import { Ek } from '#engine/shared/vocab.js';
import type { NodeProps } from '#engine/shared/types.js';

type Walked = NodeProps[keyof NodeProps] | ReadonlyArray<unknown> | object | string | number | boolean | null | undefined;

const isRecord = (value: Walked | unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null;

/** The data a node with these props reads, as written (`cart.total`, `items`), each once. */
export function nodeReads(props: NodeProps | undefined, isData: (head: string) => boolean): string[] {
  const found = new Set<string>();
  const add = (name: string): void => { const head = name.split('.')[0]; if (isData(head)) found.add(name.split('.').slice(0, 2).join('.')); };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!isRecord(value)) return;
    if (value.kind === Ek.Ref && typeof value.name === 'string') add(value.name);
    if (typeof value.$param === 'string') add(value.$param);
    for (const inner of Object.values(value)) walk(inner);
  };
  if (!props) return [];
  walk(props);
  // a prop passed by name (`inputs(data: @sales)`, `bind(q)`) is a ref written as a string
  for (const given of Object.values(props.inputs || {})) if (typeof given === 'string') add(given.replace(/^@/, ''));
  if (props.bind) add(props.bind);
  return [...found];
}
