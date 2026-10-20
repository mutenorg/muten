// runtime-signals: the reactive core every compiled page runs on: signals (state), derived values (`get`) and effects
// (the DOM bindings). Re-exported by runtime.ts; no dependencies.
//
// PUSH MARKS, PULL VALUES. Setting a signal only MARKS what may have changed: its direct readers dirty, everything
// further down «check». Nothing is computed during that walk. A derived value computes when it is READ, and only if
// something it read really changed; an effect marked «check» first asks its derived values, and does not run at all
// when none of them changed. The old core recomputed every `get` the moment any input moved (read or not), in the
// order the inputs happened to be subscribed: a `get` reading two others could compute once with one fresh input and
// one stale (a value that never existed) and then again.

import type { Signal, EffectRun } from '#engine/shared/types.js';

/** How sure a reaction is that it is up to date: clean, maybe stale (an upstream derived value may have changed), stale. */
enum Mark { Clean, Check, Dirty }

/** Anything that can be read: a signal or a derived value. Knows who read it; a derived value also knows itself. */
interface Cell { readonly observers: Set<Reaction>; reaction?: Reaction }

/** A derived value or an effect: something that runs a function and remembers what it read. */
interface Reaction {
  mark: Mark;
  readonly sources: Set<Cell>;
  readonly effect: boolean;
  readonly sync: boolean;
  disposed: boolean;
  cell?: Cell;       // a derived value's own cell (its readers); an effect has none
  compute(): void;   // run the function again (a derived value marks its readers dirty when its value changes)
}

let current: Reaction | null = null;   // the reaction running now: what it reads, it depends on
let owner: Array<Reaction | (() => void)> | null = null;   // reactions + teardowns created in the current scope

function track(cell: Cell): void {
  if (!current) return;
  current.sources.add(cell);
  cell.observers.add(current);
}

function untrackAll(reaction: Reaction): void {
  for (const source of reaction.sources) source.observers.delete(reaction);
  reaction.sources.clear();
}

// Batching (Solid-style): every effect a burst of sets touches runs once, in a microtask, after all of them. A `sync`
// effect runs as soon as the set that touched it has finished marking.
let pending: Set<Reaction> | null = null;
let syncQueue: Reaction[] = [];
function flush(): void { const runs = pending; pending = null; if (runs) for (const reaction of runs) refresh(reaction); }
function schedule(reaction: Reaction): void {
  if (reaction.sync) { syncQueue.push(reaction); return; }
  if (!pending) { pending = new Set(); queueMicrotask(flush); }
  pending.add(reaction);
}
function runSync(): void {
  while (syncQueue.length) { const queue = syncQueue; syncQueue = []; for (const reaction of queue) refresh(reaction); }
}

// Mark the readers of a changed cell: its direct readers as `level`, everyone further down as «check». An effect is
// scheduled the first time it is marked; a derived value passes «check» on, once.
function mark(observers: Set<Reaction>, level: Mark): void {
  for (const reaction of observers) {
    if (reaction.disposed || reaction.mark >= level) continue;
    const was = reaction.mark;
    reaction.mark = level;
    if (was !== Mark.Clean) continue;                       // already marked: already scheduled / already passed on
    if (reaction.effect) schedule(reaction);
    else if (reaction.cell) mark(reaction.cell.observers, Mark.Check);
  }
}

// Bring a reaction up to date: a «check» first refreshes the derived values it read (each may turn it dirty); a dirty
// one computes. A «check» whose inputs all came out unchanged is clean again without running. The mark is cleared
// BEFORE computing, so a reaction that writes a signal it reads (a converging effect) is marked and runs again.
function refresh(reaction: Reaction): void {
  if (reaction.disposed) return;
  if (reaction.mark === Mark.Check) {
    for (const source of reaction.sources) {
      if (source.reaction) refresh(source.reaction);
      if (isDirty(reaction)) break;                         // refreshing that source marked this one dirty: it computes
    }
  }
  const dirty = reaction.mark === Mark.Dirty;
  reaction.mark = Mark.Clean;
  if (dirty) reaction.compute();
}

// read through a call: refresh() changes the mark behind the type checker's back
function isDirty(reaction: Reaction): boolean { return reaction.mark === Mark.Dirty; }

function run<R>(reaction: Reaction, fn: () => R): R {
  untrackAll(reaction);                                     // dependencies are re-read every run (a `when` branch changes them)
  const prev = current; current = reaction;
  try { return fn(); } finally { current = prev; }
}

function dispose(reaction: Reaction): void { reaction.disposed = true; untrackAll(reaction); }

/** A reactive cell: reading it inside a derived value or an effect subscribes it; writing a new value marks its readers. */
export function signal<T>(value: T): Signal<T> {
  const cell: Cell = { observers: new Set() };
  return {
    get() { track(cell); return value; },
    set(next: T) { if (next === value) return; value = next; mark(cell.observers, Mark.Dirty); runSync(); },
  };
}

/** A derived value (a `get`): computed on first read, then again only when something it read has changed. */
export function computed<T>(fn: () => T): Signal<T> {
  let latest: { value: T } | null = null;
  const cell: Cell = { observers: new Set() };
  const reaction: Reaction = {
    mark: Mark.Dirty, sources: new Set(), effect: false, sync: false, disposed: false, cell,
    compute() {
      const next = run(reaction, fn);
      if (latest !== null && next === latest.value) return;
      latest = { value: next };
      for (const reader of cell.observers) if (reader.mark < Mark.Dirty) reader.mark = Mark.Dirty;
    },
  };
  cell.reaction = reaction;
  if (owner) owner.push(() => dispose(reaction));           // a page's gets let go of the stores on unmount
  const read = (): { value: T } => {
    refresh(reaction);
    return latest ?? (latest = { value: untrack(fn) });     // only a get read after its page let go of it lands here
  };
  return {
    get() { const now = read(); track(cell); return now.value; },
    set(next: T) {
      if (latest !== null && next === latest.value) return;
      latest = { value: next }; reaction.mark = Mark.Clean;
      mark(cell.observers, Mark.Dirty); runSync();
    },
  };
}

/** Runs `fn`, tracking every signal and derived value it reads; runs it again when any of them changes. */
export function effect(fn: () => void, sync?: boolean): EffectRun {
  const reaction: Reaction = {
    mark: Mark.Dirty, sources: new Set(), effect: true, sync: !!sync, disposed: false,
    compute() { run(reaction, fn); },
  };
  if (owner) owner.push(reaction);                          // belongs to the current scope, disposable on unmount/navigation
  refresh(reaction);
  return Object.assign(() => { reaction.mark = Mark.Dirty; refresh(reaction); }, { sync: !!sync, dispose: () => dispose(reaction) });
}

/** Runs `fn` without subscribing the reaction that called it. Every action runs this way: an action is a command, so
 *  what it reads (a counter it bumps, a list it appends to) must never make the calling effect depend on it, or an
 *  effect that calls an action re-runs itself for ever (notice.error bumping its own counter froze the page). */
export function untrack<T>(fn: () => T): T { const prev = current; current = null; try { return fn(); } finally { current = prev; } }

function disposeOwned(owned: Array<Reaction | (() => void)>): void {
  for (const item of owned) {
    if (typeof item === 'function') item();                 // a teardown (a keyed list disposing rows, a get letting go)
    else dispose(item);                                     // an effect
  }
}

/** Runs `fn`, collecting every reaction and teardown it creates, with a disposer that stops them all. The router uses
 *  this so an unmounted page's effects stop firing on shared store signals (no detached-DOM crashes). */
export function root<T>(fn: () => T): { value: T; dispose: () => void } {
  const prev = owner; const owned: Array<Reaction | (() => void)> = []; owner = owned;
  let value: T; try { value = fn(); } finally { owner = prev; }
  return { value, dispose: () => disposeOwned(owned) };
}
export function scope(fn: () => void): () => void { return root(fn).dispose; }
export function onCleanup(fn: () => void): void { if (owner) owner.push(fn); }
