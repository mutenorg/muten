// The app graph (app.map.json) — routes → file / models / state / sources — derived WITHOUT compiling.
// `muten map` emits it COLD (parse + flatten only, no build/SSR), so an AI can read ONE file in a fresh
// conversation and know the whole app. The build reuses `routeEntry` for the same shape (one definition).

import { relative } from 'node:path';
import { readRoutes } from '#engine/project/routes.js';
import { load, loadAllParts } from '#engine/project/load.js';
import { sourceRequest } from '#engine/shared/source.js';
import type { AppMap, Doc, Value } from '#engine/shared/types.js';

// one route's entry, from a loaded page (no compile). Shared by build.ts + mapApp so the shape can't drift.
export function routeEntry(file: string, doc: Doc, sources: { [name: string]: Value }): AppMap['routes'][string] {
  return {
    file,
    models: Object.keys(doc.entities),
    state: Object.fromEntries(Object.entries(doc.state).map(([name, def]) => [name, typeof def.source === 'string' ? def.source : (def.initial ?? null)])),
    sources: Object.fromEntries(Object.entries(sources).map(([name, src]) => [name, sourceRequest(src).url])),
  };
}

// The whole app graph from disk, cold — parse + flatten each page (no compile, no SSR, no dist).
export async function mapApp(appRoot: string): Promise<AppMap> {
  const parts = await loadAllParts(appRoot);
  const pages = readRoutes(appRoot);
  const map: AppMap = { app: appRoot.split(/[\\/]/).pop() || '', parts: Object.keys(parts), routes: {} };
  for (const page of pages) {
    const { doc, sources } = await load(page.screenPath, parts);
    map.routes['/' + page.route] = routeEntry(relative(appRoot, page.screenPath), doc, sources);
  }
  return map;
}
