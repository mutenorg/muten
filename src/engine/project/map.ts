// map: builds app.map.json (routes -> file, models, state, sources) without compiling.
// "muten map" runs cold (parse + flatten only, no build/SSR) so an AI reads one file to know the whole app.
// routeEntry is shared with build.ts to keep the shape consistent. Consumed by the CLI map command.

import { relative, join } from 'node:path';
import { readRoutes } from '#engine/project/routes.js';
import { load, loadAllParts, findStores } from '#engine/project/load.js';
import { storeContext } from '#engine/project/context.js';
import { sourceRequest } from '#engine/shared/source.js';
import type { AppMap, Doc, Value } from '#engine/shared/types.js';

// One route entry from a loaded page (no compile). Shared by build.ts and mapApp so the shape never drifts.
export function routeEntry(file: string, doc: Doc, sources: { [name: string]: Value }): AppMap['routes'][string] {
  return {
    file,
    models: Object.keys(doc.entities),
    state: Object.fromEntries(Object.entries(doc.state).map(([name, def]) => [name, typeof def.source === 'string' ? def.source : (def.initial ?? null)])),
    sources: Object.fromEntries(Object.entries(sources).map(([name, src]) => [name, sourceRequest(src).url])),
  };
}

// The whole app graph from disk, cold: parse + flatten each page (no compile, no SSR, no dist).
export async function mapApp(appRoot: string): Promise<AppMap> {
  const parts = await loadAllParts(appRoot);
  const pages = readRoutes(appRoot);
  const { storesMeta } = storeContext(findStores(join(appRoot, 'src'))); // domain -> {state, gets, actions}
  const map: AppMap = { app: appRoot.split(/[\\/]/).pop() || '', parts: Object.keys(parts), stores: storesMeta, routes: {} };
  for (const page of pages) {
    const { doc, sources } = await load(page.screenPath, parts);
    map.routes['/' + page.route] = routeEntry(relative(appRoot, page.screenPath), doc, sources);
  }
  return map;
}
