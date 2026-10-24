// motion: CSS animations and transitions as Reanimated 4 takes them (its CSS animations: `animationName` with the
// keyframes, `animationDuration`, `transitionProperty`…, on an Animated.View). The shorthand is read into its parts,
// a time into milliseconds, a curve into Reanimated's own (`cubic-bezier(…)` → cubicBezier(…), a marker the screen
// module writes as code), and each @keyframes step through the same profile as any rule. The tree draws a node that
// moves with Animated.View / Animated.Text (tree.ts).
import type { CssSheet, NativeGap, RnKeyframes, RnStyle, RnTransform } from '#engine/shared/types-native.js';
import { length, splitValue } from '#engine/native/units.js';

export const CODE = '__js:';          // a value the screen module writes as code (emit-native.ts)
export const KEYFRAMES = '__frames:'; // `__frames:mu-enter`: the frames styles.ts puts in place
const CURVES = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const STATES = new Set(['running', 'paused']);
const ALIASES: { readonly [css: string]: string } = { background: 'backgroundColor', inset: 'top' };
const TRANSFORMS = new Set(['translateX', 'translateY', 'scale', 'scaleX', 'scaleY', 'rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY', 'perspective']);

const camel = (name: string): string => ALIASES[name] ?? name.replace(/-(\w)/g, (_whole, letter: string) => letter.toUpperCase());

/** `.32s`, `200ms` → milliseconds, or null. */
export function timeMs(value: string): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(ms|s)$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * (match[2] === 's' ? 1000 : 1)) : null;
}

/** A timing function: a keyword Reanimated knows, or its cubicBezier / steps as code. */
export function curve(value: string): string | null {
  const text = value.trim();
  if (CURVES.has(text)) return text;
  const bezier = /^cubic-bezier\(([^)]+)\)$/.exec(text);
  if (bezier) { const numbers = bezier[1].split(',').map((part) => Number(part.trim())); return numbers.length === 4 && numbers.every(Number.isFinite) ? `${CODE}cubicBezier(${numbers.join(', ')})` : null; }
  const steps = /^steps\(\s*(\d+)\s*(?:,\s*([\w-]+))?\)$/.exec(text);
  if (steps) return `${CODE}steps(${steps[1]}${steps[2] ? `, ${JSON.stringify(steps[2])}` : ''})`;
  return null;
}

/** `animation: mu-enter .32s cubic-bezier(.2,.75,.2,1) both` → Reanimated's animation props (the first of a list). */
export function animation(value: string, out: RnStyle, say: (why: string) => void): void {
  if (value.trim() === 'none') return;
  const list = value.split(/,(?![^(]*\))/);
  if (list.length > 1) say('only the first of several animations runs on the phone');
  let times = 0;
  for (const part of splitValue(list[0])) {
    const ms = timeMs(part);
    if (ms !== null) { out[times++ === 0 ? 'animationDuration' : 'animationDelay'] = ms; continue; }
    const timing = curve(part);
    if (timing) { out.animationTimingFunction = timing; continue; }
    if (part === 'infinite' || /^\d+(\.\d+)?$/.test(part)) { out.animationIterationCount = part === 'infinite' ? 'infinite' : Number(part); continue; }
    if (DIRECTIONS.has(part)) { out.animationDirection = part; continue; }
    if (FILLS.has(part)) { out.animationFillMode = part; continue; }
    if (STATES.has(part)) { out.animationPlayState = part; continue; }
    out.animationName = `${KEYFRAMES}${part}`;
  }
}

/** `transition: transform .2s ease, opacity .2s` → Reanimated's transition props, one entry per property. */
export function transition(value: string, out: RnStyle): void {
  if (value.trim() === 'none') return;
  const props: string[] = [], durations: number[] = [], curves: string[] = [], delays: number[] = [];
  for (const item of value.split(/,(?![^(]*\))/)) {
    let name = 'all', duration = 0, delay = 0, timing = 'ease', times = 0;
    for (const part of splitValue(item)) {
      const ms = timeMs(part);
      if (ms !== null) { if (times++ === 0) duration = ms; else delay = ms; continue; }
      const found = curve(part);
      if (found) timing = found; else name = part;
    }
    props.push(name === 'all' ? 'all' : camel(name)); durations.push(duration); curves.push(timing); delays.push(delay);
  }
  out.transitionProperty = props;
  out.transitionDuration = durations.length === 1 ? durations[0] : durations.map(String);
  out.transitionTimingFunction = curves.length === 1 ? curves[0] : curves;
  if (delays.some((ms) => ms > 0)) out.transitionDelay = delays.length === 1 ? delays[0] : delays.map(String);
}

/** `translateY(12px) scale(.98)` → `[{ translateY: 12 }, { scale: 0.98 }]` (what an animated frame takes); `none` → []. */
export function transformList(value: string): RnTransform[] | null {
  if (value.trim() === 'none') return [];
  const out: RnTransform[] = [];
  for (const [, name, args] of value.matchAll(/([a-zA-Z]+)\(([^)]*)\)/g)) {
    const parts = args.split(',').map((part) => part.trim());
    const amount = (raw: string): number | string | null => (/deg|rad|turn$/.test(raw) ? raw : /^-?[\d.]+$/.test(raw) ? Number(raw) : typeof length(raw) === 'number' ? Number(length(raw)) : null);
    if (name === 'translate') { const x = amount(parts[0]), y = amount(parts[1] ?? '0'); if (x === null || y === null) return null; out.push({ translateX: x }, { translateY: y }); continue; }
    if (name === 'scale' && parts.length === 2) { out.push({ scaleX: Number(parts[0]) }, { scaleY: Number(parts[1]) }); continue; }
    if (!TRANSFORMS.has(name)) return null;
    const value = amount(parts[0]);
    if (value === null) return null;
    out.push({ [name]: value });
  }
  return out;
}

/** The frames of an animation, each step through `translate`; a gap when the sheet has no such @keyframes. */
export function keyframesOf(name: string, sheet: CssSheet, translateStep: (decls: Array<[string, string]>) => RnStyle, gaps: NativeGap[]): RnKeyframes | null {
  const steps = sheet.keyframes[name];
  if (!steps) { gaps.push({ kind: 'value', what: `animation ${name}`, why: 'no @keyframes with that name in the app\'s CSS', level: 'none' }); return null; }
  const out: RnKeyframes = {};
  for (const step of steps) {
    const style = translateStep(step.decls.filter(([prop]) => prop !== 'transform'));
    const transform = step.decls.find(([prop]) => prop === 'transform');
    if (transform) { const list = transformList(transform[1]); if (list) style.transform = list; else gaps.push({ kind: 'value', what: `transform: ${transform[1]}`, why: 'a transform function the phone does not animate', level: 'none' }); }
    for (const offset of step.offsets) out[offset] = { ...(out[offset] || {}), ...style };
  }
  return out;
}
