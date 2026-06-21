# style — the token vocabulary

muten's styling surface is **layout + typography vocabulary only**. This domain owns the *vocabulary*
(which token families/atoms exist and which CSS property each maps to) — the engine's single source of
truth for what styling it accepts. It owns **no values**: the scale (`md = 16px`), breakpoint pixels
and the reset all come from the project (`theme.muten` + the stylesheet). Vocabulary = engine; values
+ look = project.

| File | What it does |
|---|---|
| `tokens.ts` | The token families (`gap`/`padding`/`cols`/`text`/…) and atoms (`row`/`grid`/`bold`/…), `resolveToken()` (token → CSS, using the project theme), `isKnownTokenShape()` (strict validation, independent of values), `mergeTheme()` and `defaultTheme` (empty — the project fills it). |
