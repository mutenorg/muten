// Public API: the programmatic surface of the framework.
// Consumers: host apps via `import { buildApp } from 'muten'`, and embedders
// using the compiler pipeline directly. Everything under #engine is internal
// and may change between versions.

export { buildApp } from './build.js';
export { lintApp } from './lint.js';

// pure compiler pipeline (advanced / embedding use — e.g. an in-browser playground)
export { parse } from '#engine/lang/parse.js';
export { toDoc } from '#engine/ir/flatten.js';
export { compose, composeDoc } from '#engine/ir/compose.js';
export { validate } from '#engine/ir/validate.js';
export { compile, compileModule, compileStore } from '#engine/compile/compile.js';
export { Fmt } from '#engine/shared/vocab.js';
export { load, loadAllParts } from '#engine/project/load.js';
