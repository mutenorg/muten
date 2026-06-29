// The pure compiler pipeline, for in-browser embedding (an interactive playground / REPL).
// Everything re-exported here lives under #engine, which is Node-free — no fs, no path — so this
// entry bundles cleanly for the browser. The `.` entry can't: it also re-exports build/lint (Node).
//   import { parse, composeDoc, compileModule, compile, Fmt } from '@muten/core/browser.js'
export { parse } from '#engine/lang/parse.js';
export { toDoc } from '#engine/ir/flatten.js';
export { compose, composeDoc } from '#engine/ir/compose.js';
export { validate } from '#engine/ir/validate.js';
export { compile, compileModule } from '#engine/compile/compile.js';
export { print } from '#engine/ir/print.js';
export { emitTheme } from '#engine/style/tokens.js';
export { Fmt } from '#engine/shared/vocab.js';
