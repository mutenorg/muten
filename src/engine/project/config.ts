// config.ts: parse `muten.config` (written in muten syntax) into a generic nested structure, and map its
// `styling {}` block to a ThemeAdapter. The build config is muten, not JS — the only .js/.ts in a muten app
// are the escapes (Custom / use). Pure (no fs): the caller reads the file and passes the text.
//
// Grammar (uniform, reusing muten's tokens): a file is a sequence of `name { … }` blocks; a block body is
// `key <value>` entries; a value is a string, number, bool, bare ident, list `[ … ]`, or a nested block.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tk, Pn } from '#engine/shared/vocab.js';
import { tokenize } from '#engine/lang/lexer.js';
import type { ThemeAdapter, ThemeBlock } from '#engine/shared/types.js';

export type ConfigValue = string | number | boolean | ConfigValue[] | ConfigBlock;
export interface ConfigBlock { [key: string]: ConfigValue; }
export type MutenConfig = { [block: string]: ConfigBlock };

// Read <appRoot>/muten.config (the build config), or {} if absent. ONE reader for every emitter (dev plugin +
// SSG build) so the theme adapter and Form class map are applied identically everywhere — no per-path drift.
export function readMutenConfig(appRoot: string): MutenConfig {
  const file = join(appRoot, 'muten.config');
  return existsSync(file) ? parseConfig(readFileSync(file, 'utf8')) : {};
}

export function parseConfig(source: string): MutenConfig {
  const tokens = tokenize(source);
  let i = 0;
  const at = (t: Tk, v?: string): boolean => tokens[i].t === t && (v === undefined || tokens[i].v === v);
  const eat = (t: Tk, v?: string): string => {
    if (!at(t, v)) throw new Error(`muten.config: expected ${v ?? t}, got ${JSON.stringify(tokens[i].v || '<eof>')}`);
    return tokens[i++].v;
  };

  const value = (): ConfigValue => {
    const tok = tokens[i];
    if (tok.t === Tk.String) { i++; return tok.v; }
    if (tok.t === Tk.Number) { i++; return Number(tok.v); }
    if (at(Tk.Punct, Pn.BraceL)) return block();
    if (at(Tk.Punct, Pn.BrackL)) return list();
    if (tok.t === Tk.Ident) { i++; return tok.v === 'true' ? true : tok.v === 'false' ? false : tok.v; } // bool or bare enum
    throw new Error(`muten.config: unexpected ${JSON.stringify(tok.v || '<eof>')}`);
  };

  const list = (): ConfigValue[] => {
    eat(Tk.Punct, Pn.BrackL);
    const out: ConfigValue[] = [];
    while (!at(Tk.Punct, Pn.BrackR)) { out.push(value()); if (at(Tk.Punct, Pn.Comma)) i++; }
    eat(Tk.Punct, Pn.BrackR);
    return out;
  };

  const block = (): ConfigBlock => {
    eat(Tk.Punct, Pn.BraceL);
    const out: ConfigBlock = {};
    // keys are idents or quoted strings (hyphenated CSS keys like "color-scheme", "base-100")
    while (!at(Tk.Punct, Pn.BraceR)) { const key = at(Tk.String) ? tokens[i++].v : eat(Tk.Ident); out[key] = value(); }
    eat(Tk.Punct, Pn.BraceR);
    return out;
  };

  const config: MutenConfig = {};
  while (tokens[i].t !== Tk.Eof) { const name = eat(Tk.Ident); config[name] = block(); }
  return config;
}

// honest runtime narrowing (no `as`): a ConfigValue is a union, so we guard before reading each shape.
const asStr = (v: ConfigValue | undefined): string => (typeof v === 'string' ? v : '');
const asBlock = (v: ConfigValue | undefined): ConfigBlock => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {});
const asStrList = (v: ConfigValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// The `styling {}` block -> a ThemeAdapter (how theme.muten maps to CSS vars). Library-agnostic: pure data.
//   styling { prefix { colors "--color-" }  blocks { base { selector "@theme" sections [colors] } } }
// Each block gives a CSS `selector` (no braces — muten strings can't hold `{`; the `}`/`{` are added here, and
// attribute values use single quotes: `[data-theme='light']`, valid CSS); the mapping wraps it into a block.
export function configThemeAdapter(config: MutenConfig): ThemeAdapter | undefined {
  const styling = config.styling;
  if (!styling) return undefined;
  const prefix: { [section: string]: string } = {};
  for (const [section, p] of Object.entries(asBlock(styling.prefix))) prefix[section] = asStr(p);
  const blocks: ThemeBlock[] = Object.values(asBlock(styling.blocks)).map((b) => {
    const bb = asBlock(b);
    const attrs: { [key: string]: string } = {};
    for (const [k, v] of Object.entries(asBlock(bb.attrs))) attrs[k] = asStr(v);  // literal lines inside (e.g. DaisyUI name/default)
    const out: ThemeBlock = { open: asStr(bb.selector) + ' {', close: '}', sections: asStrList(bb.sections) };
    if (Object.keys(attrs).length) out.attrs = attrs;
    return out;
  });
  return { prefix, blocks };
}

// The `styling { classes {} }` block -> the Form class map (slot -> library classes; DaisyUI only). undefined if absent.
export function configClasses(config: MutenConfig): { [slot: string]: string } | undefined {
  const classes = asBlock(config.styling?.classes);
  const out: { [slot: string]: string } = {};
  for (const [slot, v] of Object.entries(classes)) out[slot] = asStr(v);
  return Object.keys(out).length ? out : undefined;
}
