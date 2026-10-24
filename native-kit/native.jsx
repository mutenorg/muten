// muten's native kit: what a compiled screen (engine/native/emit-native.ts) draws with. Copied as it is into every
// generated Expo app. The bridge between muten's signals and React is here, and it is small:
//   · useMuten runs a screen's logic once, in a muten root disposed when the screen leaves;
//   · R is a fine-grained piece: its JSX is a muten `computed`, so it redraws alone, and only when what it read changed;
//   · Field and Check are bound inputs; go navigates.
import React, { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Appearance, Dimensions, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Redirect, router, usePathname } from 'expo-router';
import { computed, effect, root, signal } from 'virtual:muten/runtime';
import './storage';   // a localStorage on the phone (SQLite), for `persist`, before any store reads it (written by muten)
import './intl';   // what Hermes lacks of Intl and the screens use, polyfilled (written by muten for each app)

/** A screen's logic, run once; the value it returns (the function that draws the screen). */
export function useMuten(make) {
  const [made] = useState(() => root(make));
  useEffect(() => () => made.dispose(), [made]);
  return made.value;
}

/** The current value of `read` (any muten expression), redrawing this component when it changes. */
export function useValue(read) {
  const cell = useMemo(() => root(() => computed(read)), [read]);
  useEffect(() => () => cell.dispose(), [cell]);
  const subscribe = useMemo(() => (changed) => {
    const watch = root(() => { let first = true; effect(() => { cell.value.get(); if (first) { first = false; return; } changed(); }); });
    return watch.dispose;
  }, [cell]);
  return useSyncExternalStore(subscribe, () => cell.value.get());
}

/** A piece of the screen that reads signals: drawn by `render`, redrawn alone when what it read changes. */
export function R({ render }) {
  return useValue(render);
}

/** A text field bound to a state: shows what `read` gives, and hands every keystroke to `write`. A style given as a
 *  function follows the field's focus (the CSS asked for :focus). */
export function Field({ read, write, style, ...rest }) {
  const value = useValue(read);
  const [focused, setFocused] = useState(false);
  const look = typeof style === 'function' ? style(focused) : style;
  return <TextInput style={look} value={value == null ? '' : String(value)} onChangeText={write} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} {...rest} />;
}

// ── the screen, live: what @media conditions read (engine/native/media.ts) ──
const measure = () => { const { width, height } = Dimensions.get('window'); return { width, height, dark: Appearance.getColorScheme() === 'dark' }; };
/** The window's size and the system's color scheme, as a muten signal: a style under @media follows it by itself. */
export const screen = signal(measure());
Dimensions.addEventListener('change', () => screen.set(measure()));
Appearance.addChangeListener(() => screen.set(measure()));

// ── grid: React Native has only flexbox, so a grid is a wrapping row whose cells take their width from here ──
const GridContext = createContext(null);
const inner = (width, style) => {
  const flat = StyleSheet.flatten(style) || {};
  const side = (key, fallback) => (typeof flat[key] === 'number' ? flat[key] : typeof flat[fallback] === 'number' ? flat[fallback] : 0);
  return width - side('paddingLeft', 'padding') - side('paddingRight', 'padding') - side('borderLeftWidth', 'borderWidth') - side('borderRightWidth', 'borderWidth');
};

/** A CSS grid (engine/native/grid.ts plans its columns): measured once laid out, hidden until then so nothing jumps. */
export function Grid({ plan, style, children }) {
  const [width, setWidth] = useState(0);
  const single = plan.tracks.some((track) => track.auto);   // a track sized by its content: one flex row
  return (
    <GridContext.Provider value={{ plan, width, single }}>
      <View style={[style, { columnGap: plan.columnGap }, single && { flexWrap: 'nowrap' }, !width && !single && { opacity: 0 }]} onLayout={(event) => setWidth(inner(event.nativeEvent.layout.width, style))}>
        {children}
      </View>
    </GridContext.Provider>
  );
}

/** One cell of a Grid: the width of its column (the free width shared by fr, fixed tracks as written). */
export function Cell({ index, children }) {
  const grid = useContext(GridContext);
  if (!grid) return children;
  const { plan, width, single } = grid;
  const track = plan.tracks[index % plan.tracks.length];
  if (single) return <View style={track.fr ? { flexGrow: track.fr, flexShrink: 1, flexBasis: 0, minWidth: 0 } : track.width ? { width: track.width } : null}>{children}</View>;
  const fixed = plan.tracks.reduce((sum, one) => sum + (one.width || 0), 0);
  const shares = plan.tracks.reduce((sum, one) => sum + (one.fr || 0), 0) || 1;
  const free = width - fixed - plan.columnGap * (plan.tracks.length - 1);
  const size = track.fr ? (free * track.fr) / shares : track.width || 0;
  return <View style={{ width: Math.max(0, Math.floor(size * 100) / 100 - 0.01) }}>{children}</View>;
}

// ── run-time CSS variables: `style(w: "45%")` on the page, `width: var(--w)` in the CSS ──
const LIVE_LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|%)?$/;
const LIVE_ALIAS = { background: 'backgroundColor' };
/** CSS values the page sets while it runs, as a React Native style. */
export function liveStyle(entries) {
  const out = {};
  for (const [prop, raw] of Object.entries(entries)) {
    const key = LIVE_ALIAS[prop] || prop.replace(/-(\w)/g, (_whole, letter) => letter.toUpperCase());
    const value = String(raw ?? '').trim();
    const length = LIVE_LENGTH.exec(value);
    out[key] = length ? (length[2] === '%' ? `${length[1]}%` : Number(length[1]) * (length[2] === 'rem' ? 16 : 1)) : value;
  }
  return out;
}

/** A checkbox: a box that shows `read` and calls `write` with the new value when pressed. */
export function Check({ read, write, style, labelStyle, label }) {
  const on = !!useValue(read);
  return (
    <Pressable style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]} onPress={() => write(!on)} accessibilityRole="checkbox" accessibilityState={{ checked: on }}>
      <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: '#6B46F2', backgroundColor: on ? '#6B46F2' : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {on ? <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>✓</Text> : null}
      </View>
      {label ? <Text style={labelStyle}>{label}</Text> : null}
    </Pressable>
  );
}

// the screens on the stack, by path, kept in step with every move (go, the back button, a deep link): a link to a
// screen that is already open goes back to it, as on the web, instead of piling a fresh copy on top
const trail = [];

/** Keeps the trail in step with where the app is. Called once, by the app's layout. */
export function useTrail() {
  const path = usePathname();
  useEffect(() => {
    const at = trail.lastIndexOf(path);
    if (at >= 0) trail.length = at + 1; else trail.push(path);
  }, [path]);
}

/** A guarded route's screen: shown while `allow` holds; the moment it stops (a login, a logout), on to `redirect`. */
export function Guarded({ allow, redirect, children }) {
  return useValue(allow) ? children : <Redirect href={redirect} />;
}

/** A muten path (`/product/42`), opened in the app's navigation: back to it if it is already open, else on top. */
export function go(path) {
  if (trail.slice(0, -1).includes(path)) router.dismissTo(path);
  else router.push(path);
}
