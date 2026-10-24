// types-native: the shapes of the native output (engine/native/): the app's CSS as read, the React Native style a node
// ends up with, and the report of what did not translate. Re-exported by types.ts.

import type { Expr } from '#engine/shared/types.js';

/** One CSS rule: its selectors, its declarations in order, its place in the sheet (later wins at equal weight), the
 *  line it starts on (for `muten check`), and the @media condition it sits under, if any. */
export interface CssRule { selectors: string[]; decls: Array<[string, string]>; order: number; line: number; media?: string; layer?: number }

/** The app's stylesheet as the native output reads it. */
export interface CssSheet { rules: CssRule[]; vars: { [name: string]: string }; keyframes: { [name: string]: CssFrame[] }; skipped: Array<{ what: string; line: number }> }

/** One step of a @keyframes block: its offsets (`from`, `50%`) and its declarations. */
export interface CssFrame { offsets: string[]; decls: Array<[string, string]> }

/** A React Native style value: points, a string (a color, a percentage, a weight, a marker), or a list (fontVariant). */
export type RnValue = string | number | string[] | { width: number; height: number } | RnKeyframes | RnTransform[];

/** A transform step as React Native takes it: `{ translateY: 12 }`, `{ rotate: '45deg' }`. */
export interface RnTransform { [fn: string]: number | string }

/** An animation's frames, as Reanimated's CSS animations take them: `{ from: {…}, '50%': {…}, to: {…} }`. */
export interface RnKeyframes { [offset: string]: RnStyle }

/** A React Native style object. */
export interface RnStyle { [prop: string]: RnValue }

/** How faithfully the native output says a CSS feature: the same result, a stated difference, or not at all. */
export type NativeLevel = 'exact' | 'approx' | 'none';

/** One line of the native CSS profile: its level, and what to know (the difference, or what to write instead). */
export interface ProfileNote { level: NativeLevel; note: string }

/** A style a node takes while a condition holds: a muten condition (`class("on" when open)`, `disabled when …`) or a
 *  condition the kit knows while the app runs (the window's width, dark mode, the row's index, a press, a focus). */
export interface RnConditional { cond?: Expr; js?: string; style: RnStyle; text: RnStyle }

/** What a Text takes as props, not style: how many lines it may wrap to, and how it is cut. */
export interface TextProps { numberOfLines?: number; ellipsizeMode?: string }

/** A grid container's columns: each a share of the free width (fr), a fixed width, or its content's (auto). */
export interface GridTrack { fr?: number; width?: number; auto?: boolean }
export interface GridPlan { tracks: GridTrack[]; columnGap: number }

/** A declaration that reads a variable the page sets while it runs (`style(w: "{pct}%")` → `width: var(--w)`). */
export interface LiveDecl { prop: string; value: string }

/** What the native output did with a node's look: its box's style, the style of the text it shows (a Button's label
 *  is text inside a box), the styles that follow a condition, and what is not style (text props, a field's
 *  placeholder color, an image's fit, a grid it lays out, declarations that read run-time variables). */
export interface NodeLook {
  style: RnStyle; text: RnStyle; conditional: RnConditional[];
  textProps: TextProps; placeholderColor?: string; fit?: string; grid?: GridPlan; live: LiveDecl[];
  boxed?: boolean;   // a text the web lays out as a flex box: drawn as a View with the Text inside
}

/** Something that did not translate (or translated with a difference), and why. */
export interface NativeGap { kind: 'property' | 'selector' | 'value' | 'primitive' | 'feature' | 'media'; what: string; why: string; level?: NativeLevel; line?: number }

/** The native output's report for one page: what translated and what did not, each gap once with how many times. */
export interface NativeReport { nodes: number; translated: number; gaps: Array<NativeGap & { count: number }> }
