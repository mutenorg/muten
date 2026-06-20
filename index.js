// Public API — the programmatic surface of the framework.
//
//   import { buildApp } from 'muten'        // compile an app folder
//   import { compile, parse, validate } from 'muten'   // drive the compiler directly
//
// Everything under ./engine is internal and may change; depend on these exports.

export { buildApp } from './build.js';
export { lintApp } from './lint.js';

// the pure compiler (advanced / embedding use)
export { parse } from './engine/parse.js';
export { toDoc } from './engine/flatten.js';
export { validate } from './engine/validate.js';
export { compile } from './engine/compile.js';
export { load, loadAllParts } from './engine/load.js';
