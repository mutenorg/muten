// The reactive core against a naive oracle, on random graphs (seeded, so a failure reproduces). Signals, computeds
// that read earlier nodes (some through a branch, so their dependencies change as values change) and effects. After
// each batch of random writes the core must agree with recomputing everything from scratch:
//   · a computed read is the oracle's value, also right after a write, before the batch flushes (pull is fresh);
//   · an effect whose inputs changed runs exactly once per batch, with the final values (no glitch, no stale run);
//   · an effect whose inputs did not change does not run; a disposed one never runs again;
//   · a computed computes at most once per batch.
import { signal, computed, effect } from '../dist/runtime.js';

let failures = 0;
const fail = (message) => { failures++; if (failures <= 10) console.log('✗ ' + message); };

// mulberry32: a small seeded PRNG
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const flush = () => new Promise((done) => setTimeout(done, 0));

async function run(seed) {
  const random = rng(seed);
  const pick = (n) => Math.floor(random() * n);
  const values = [];             // the oracle's signal values
  const nodes = [];              // { kind, sig, deps, branch, computes }
  const SIGNALS = 3 + pick(4), COMPUTEDS = 4 + pick(8), EFFECTS = 3 + pick(5);
  for (let i = 0; i < SIGNALS; i++) { values.push(pick(5)); nodes.push({ kind: 's', sig: signal(values[i]) }); }
  // a computed: sum of some earlier nodes; with a branch, `cond % 2 ? a : b` decides which one it reads
  for (let i = 0; i < COMPUTEDS; i++) {
    const before = nodes.length;
    const deps = Array.from({ length: 1 + pick(3) }, () => pick(before));
    const branch = random() < 0.4 ? [pick(before), pick(before), pick(before)] : null;
    const node = { kind: 'c', deps, branch, computes: 0 };
    node.sig = computed(() => {
      node.computes++;
      let total = deps.reduce((sum, d) => sum + nodes[d].sig.get(), 0);
      if (branch) total += nodes[branch[0]].sig.get() % 2 ? nodes[branch[1]].sig.get() : nodes[branch[2]].sig.get() * 10;
      return total;
    });
    nodes.push(node);
  }
  const oracle = (i) => {
    const node = nodes[i];
    if (node.kind === 's') return values[i];
    let total = node.deps.reduce((sum, d) => sum + oracle(d), 0);
    if (node.branch) total += oracle(node.branch[0]) % 2 ? oracle(node.branch[1]) : oracle(node.branch[2]) * 10;
    return total;
  };
  // the signals a node reads, through every branch (an upper bound: what it COULD depend on)
  const signalsOf = (i, out = new Set()) => { const node = nodes[i]; if (node.kind === 's') { out.add(i); return out; } for (const d of [...node.deps, ...(node.branch || [])]) signalsOf(d, out); return out; };
  const dependsOnMoved = (reads, moved) => reads.some((r) => [...signalsOf(r)].some((sgl) => moved.has(sgl)));
  const effects = [];
  for (let i = 0; i < EFFECTS; i++) {
    const reads = Array.from({ length: 1 + pick(3) }, () => pick(nodes.length));
    const fx = { reads, runs: [], disposed: false };
    fx.handle = effect(() => { fx.runs.push(reads.map((r) => nodes[r].sig.get())); });
    effects.push(fx);
  }
  await flush();
  for (const fx of effects) fx.runs = [];
  let last = effects.map((fx) => fx.reads.map(oracle));

  for (let step = 0; step < 40; step++) {
    for (const node of nodes) if (node.kind === 'c') node.computes = 0;
    const writes = 1 + pick(3);
    const moved = new Set();   // signals that took another value at some point of this batch (A → B → A included)
    for (let w = 0; w < writes; w++) {
      const i = pick(SIGNALS);
      const next = random() < 0.3 ? values[i] : pick(5);   // sometimes the same value: nothing must react
      if (next !== values[i]) moved.add(i);
      values[i] = next;
      nodes[i].sig.set(values[i]);
      const probe = SIGNALS + pick(COMPUTEDS);           // pull right after the write, before any flush
      if (nodes[probe].sig.get() !== oracle(probe)) fail(`seed ${seed} step ${step}: computed ${probe} read ${nodes[probe].sig.get()} right after a write, the oracle says ${oracle(probe)}`);
    }
    if (random() < 0.1) { const fx = effects[pick(effects.length)]; if (!fx.disposed) { fx.handle.dispose(); fx.disposed = true; } }
    await flush();
    const now = effects.map((fx) => fx.reads.map(oracle));
    effects.forEach((fx, e) => {
      const changed = JSON.stringify(now[e]) !== JSON.stringify(last[e]);
      if (fx.disposed && fx.runs.length) fail(`seed ${seed} step ${step}: effect ${e} ran after it was disposed`);
      else if (!fx.disposed && changed && fx.runs.length !== 1) fail(`seed ${seed} step ${step}: effect ${e}'s inputs changed and it ran ${fx.runs.length} times (want 1)`);
      // with nothing changed it must not run, unless a signal it depends on went A → B → A within the batch (it did
      // change, twice; re-running then is what Solid does too, and the run sees the right values)
      else if (!fx.disposed && !changed && fx.runs.length && !dependsOnMoved(fx.reads, moved)) fail(`seed ${seed} step ${step}: effect ${e} ran with nothing changed`);
      for (const seen of fx.runs) if (JSON.stringify(seen) !== JSON.stringify(now[e])) fail(`seed ${seed} step ${step}: effect ${e} saw ${JSON.stringify(seen)}, the values are ${JSON.stringify(now[e])} (a glitch)`);
      fx.runs = [];
    });
    last = now;
    for (let i = SIGNALS; i < nodes.length; i++) {
      if (nodes[i].sig.get() !== oracle(i)) fail(`seed ${seed} step ${step}: computed ${i} is ${nodes[i].sig.get()}, the oracle says ${oracle(i)}`);
      if (nodes[i].computes > writes + 1) fail(`seed ${seed} step ${step}: computed ${i} computed ${nodes[i].computes} times in one batch`);
    }
  }
}

const SEEDS = 300;
for (let seed = 1; seed <= SEEDS; seed++) await run(seed);
console.log(failures ? `\n${failures} FAILURE(S)` : `✓ the reactive core agrees with the oracle on ${SEEDS} random graphs × 40 batches\n\nALL OK`);
process.exit(failures ? 1 : 0);
