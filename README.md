# muten

AI-first frontend framework. You write `.muten` files; it compiles them to a
self-contained `index.html` (vanilla JS + fine-grained signals). No runtime to ship,
no virtual DOM. Designed so an AI can **locate and mutate** an app cheaply.

## Install

```sh
npm install -D muten
```

## An app, by convention

```
my-app/
├─ src/
│  ├─ app.muten            # the ROOT: routes + (later) shared shell/models
│  ├─ pages/
│  │  └─ home/home.muten   # a page; folder = route target
│  ├─ parts/              # reusable .muten components (object + action params)
│  └─ components/         # host-written Custom JS (the escape hatch)
└─ dist/                  # build output (generated)
```

`src/app.muten` is the single source of truth the AI reads first:

```
routes {
  / -> home
}
```

## Commands

```sh
muten build      # compile ./ → ./dist/<route>/index.html (+ dist/app.map.json)
muten lint       # parse + validate every page, no compile
```

Both default to the current directory; pass a path to target another: `muten build ./my-app`.

## Programmatic API

```js
import { buildApp, compile, parse, validate } from 'muten';

await buildApp('./my-app');            // same as `muten build ./my-app`
const html = compile(toDoc(parse(src))); // drive the compiler directly
```

Anything under `engine/` is internal; depend only on the exports above.

## Styling & escape hatch

The engine imposes no theme. A page styles itself with a colocated `.scss`/`.css`
(`pages/home/home.scss`) injected after the defaults. For behavior the primitives
can't express, drop to a `Custom` component (`src/components/<Name>.js`).
