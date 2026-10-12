// app-map-file.ts: where the app graph (app.map.json) is written. It names every route, guard, store and state field —
// the map an AI reads to know the whole app — so it lives on this machine, in `.muten/` at the project root, and NEVER
// in the folder that gets deployed (dist/). Consumed by esbuild-muten.ts (bundle) and build.ts (SSG).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeAppMap(root: string, map: object): string {
  const dir = join(root, '.muten');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'app.map.json');
  writeFileSync(file, JSON.stringify(map, null, 2));
  return file;
}
