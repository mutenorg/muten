# engine/native — the native output (proof of concept)

A page compiled as a React Native screen, for the Expo app `muten native` writes (`src/native-project.ts`). The page's
logic is compiled by the same `Logic` the web output uses; this domain only decides how the page is drawn and how
its CSS becomes React Native styles.

| File | Role |
|---|---|
| `css.ts` | The app's stylesheet read into rules and `:root` variables (@media and @keyframes are counted, not read). |
| `props.ts` | One CSS declaration as React Native style, or a gap saying why it has none. |
| `styles.ts` | Each node's style, decided at compile time from the CSS **and the page's tree**: descendant and child selectors, inherited text style, conditional classes. |
| `tree.ts` | The page's nodes as JSX. Anything that reads a signal is wrapped in `<R>` (the kit's fine-grained piece). |
| `emit-native.ts` | The screen module: the logic inside `useMuten`, the JSX it draws. |
| `report.ts` | The gaps, counted. |

The kit the screens draw with is `native-kit/native.jsx` (copied into every generated app): `useMuten`, `R`,
`Field`, `Check`, `go`. muten's signals reach React there and nowhere else.

**What it does not do yet** (each is a gap in the report, never a silent loss): events and gestures, icons, Custom
components, animations, `@media`, selectors that need the page at run time (`:hover`, `:first-child`), grid.
