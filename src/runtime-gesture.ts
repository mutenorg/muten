// runtime-gesture: the touch gestures `on(…)` listens for on any element, with no library:
//   on(swipe-left: next)  on(swipe-right: back)  on(swipe-up: …)  on(swipe-down: close)
//   on(long-press: menu)  on(double-tap: like)   on(pinch: zoom)   ← the action gets the scale (1 = as it started)
// One recognizer per element, whatever it listens for, on pointer events (mouse, pen and touch alike; a trackpad pinch
// arrives as ctrl+wheel and counts too). A swipe is a quick flick or a long enough drag, along one axis. The element's
// `touch-action` is set from what it listens for, so the browser keeps the rest: a carousel that swipes sideways still
// scrolls the page up and down, and only an element that pinches stops the page from zooming.

type Gesture = 'swipe-left' | 'swipe-right' | 'swipe-up' | 'swipe-down' | 'long-press' | 'double-tap' | 'pinch';
type Run = (value?: number) => void;

const SWIPE_DISTANCE = 48;      // px: a slow drag this long along one axis is a swipe
const FLICK_SPEED = 0.35;       // px/ms: a flick this fast is a swipe from 24 px
const FLICK_DISTANCE = 24;
const SWIPE_TIME = 700;         // ms: longer than this is a drag, not a swipe
const AXIS_RATIO = 1.4;         // the main axis must clearly win, or it is a diagonal and nothing fires
const HOLD = 500;               // ms for a long press
const STILL = 10;               // px a long press or a tap may wander
const DOUBLE = 300;             // ms between the taps of a double tap

// what each gesture takes from the browser's own handling (touch-action)
const TAKES: { readonly [gesture: string]: string } = { 'swipe-left': 'pan-x', 'swipe-right': 'pan-x', 'swipe-up': 'pan-y', 'swipe-down': 'pan-y', pinch: 'pinch-zoom' };
const BROWSER = ['pan-x', 'pan-y', 'pinch-zoom'];

interface Recognizer { runs: Map<Gesture, Run> }
const recognizers = new WeakMap<HTMLElement, Recognizer>();

function touchAction(el: HTMLElement, gestures: Iterable<Gesture>): void {
  const taken = new Set([...gestures].map((gesture) => TAKES[gesture]).filter(Boolean));
  if (!taken.size) return;
  const left = BROWSER.filter((part) => !taken.has(part));
  el.style.touchAction = left.length ? left.join(' ') : 'none';
}

function listen(el: HTMLElement, recognizer: Recognizer): void {
  const fire = (gesture: Gesture, value?: number): boolean => { const run = recognizer.runs.get(gesture); if (run) run(value); return !!run; };
  const pointers = new Map<number, { x: number; y: number }>();
  let start = { x: 0, y: 0, t: 0 };
  let hold = 0;
  let held = false;
  let lastTap = { x: 0, y: 0, t: 0 };
  let pinchFrom = 0;
  let scale = 1;
  let frame = 0;
  const spread = (): number => { const [a, b] = [...pointers.values()]; return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const pinchTo = (next: number): void => { scale = next; if (!frame) frame = requestAnimationFrame(() => { frame = 0; fire('pinch', Math.round(scale * 1000) / 1000); }); };

  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { clearTimeout(hold); pinchFrom = spread() / scale; return; }
    if (pointers.size > 2) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    held = false;
    if (recognizer.runs.has('long-press')) hold = window.setTimeout(() => { held = true; fire('long-press'); }, HOLD);
  });
  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchFrom && recognizer.runs.has('pinch')) { pinchTo(spread() / pinchFrom); return; }
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > STILL) clearTimeout(hold);
  });
  const end = (e: PointerEvent): void => {
    const was = pointers.size;
    pointers.delete(e.pointerId);
    clearTimeout(hold);
    if (was >= 2) { if (pointers.size < 2) pinchFrom = 0; return; }   // the end of a pinch is not a swipe or a tap
    if (e.type === 'pointercancel' || held) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Math.max(1, e.timeStamp - start.t);
    const far = Math.max(Math.abs(dx), Math.abs(dy));
    if (far <= STILL) {   // a tap: a second one soon after, close by, is a double tap
      if (e.timeStamp - lastTap.t < DOUBLE && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < FLICK_DISTANCE && fire('double-tap')) { lastTap = { x: 0, y: 0, t: 0 }; return; }
      lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      return;
    }
    if (dt > SWIPE_TIME || !(far >= SWIPE_DISTANCE || (far >= FLICK_DISTANCE && far / dt >= FLICK_SPEED))) return;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    if ((horizontal ? Math.abs(dx) / Math.max(1, Math.abs(dy)) : Math.abs(dy) / Math.max(1, Math.abs(dx))) < AXIS_RATIO) return;
    fire(horizontal ? (dx < 0 ? 'swipe-left' : 'swipe-right') : (dy < 0 ? 'swipe-up' : 'swipe-down'));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // a long press opened its own thing: the click it ends with (and the browser's menu) must not also fire
  el.addEventListener('click', (e) => { if (held) { e.preventDefault(); e.stopPropagation(); held = false; } }, true);
  el.addEventListener('contextmenu', (e) => { if (recognizer.runs.has('long-press')) e.preventDefault(); });
  // a trackpad pinch is ctrl+wheel
  el.addEventListener('wheel', (e) => { if (!e.ctrlKey || !recognizer.runs.has('pinch')) return; e.preventDefault(); pinchTo(Math.min(20, Math.max(0.05, scale * Math.exp(-e.deltaY / 100)))); }, { passive: false });
}

/** Listens for `gesture` on `el`, running `run` (with the scale, for a pinch). */
export function __gesture(el: HTMLElement, gesture: Gesture, run: Run): void {
  let recognizer = recognizers.get(el);
  if (!recognizer) { recognizer = { runs: new Map() }; recognizers.set(el, recognizer); listen(el, recognizer); }
  recognizer.runs.set(gesture, run);
  touchAction(el, recognizer.runs.keys());
}
