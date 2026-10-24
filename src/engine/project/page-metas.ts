// page-metas: what muten.config tells the runtime through index.html, as <meta> tags (no inline script, so a
// Content-Security-Policy needs nothing): `i18n { detect false }` (runtime-lang.ts) and `routes { preload … }`
// (runtime-nav.ts). Dev, `muten bundle` and `muten build` all put them in the page's <head>.
import { readMutenConfig } from '#engine/project/config.js';
import { langDetectTag } from '#engine/project/lang-files.js';

/** How the router warms the routes a reader may open next (runtime-nav.ts warmRoutes); intent is the default. */
export const PRELOAD_MODES = ['intent', 'visible', 'idle', 'none'];

function preloadTag(appRoot: string): string {
  let mode: unknown;
  try { const block = readMutenConfig(appRoot).routes; mode = block && typeof block === 'object' && !Array.isArray(block) ? block.preload : undefined; } catch { return ''; }
  return typeof mode === 'string' && PRELOAD_MODES.includes(mode) && mode !== 'intent' ? `<meta name="muten-preload" content="${mode}">` : '';
}

/** The tags, '' when muten.config asks for nothing. */
export function configMetaTags(appRoot: string): string {
  return [langDetectTag(appRoot), preloadTag(appRoot)].filter(Boolean).join('');
}
