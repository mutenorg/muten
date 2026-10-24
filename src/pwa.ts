// pwa: muten.config `pwa { }` makes the app installable, and with `offline true` able to open without a network.
//   pwa {
//     name "Storio"  short "Storio"  color "#6B46F2"  background "#ffffff"
//     icons ["public/icon-192.png", "public/icon-512.png"]
//     offline true
//   }
// `muten bundle` (and `muten build`) write manifest.webmanifest (each icon's size read from the file itself), link it
// with the theme color, and with `offline` a service worker: pages network first (a new deploy is never stuck behind an
// old cache; offline, the last copy), hashed assets cache first (their name changes when they do), the files the app
// opens with stored at install, and one cache per build, the old ones dropped. It registers from /pwa.js, a file and
// not an inline script, so a Content-Security-Policy needs nothing extra. Requests to an API are never cached: data is
// the app's to keep (`persist`), not the worker's.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Metafile } from 'esbuild';
import { readMutenConfig, type ConfigBlock } from '#engine/project/config.js';
import { closure, bootOutput } from './bundle-graph.js';

const MANIFEST = 'manifest.webmanifest';
const WORKER = 'sw.js';
const REGISTER = 'pwa.js';
const PNG_SIGNATURE = '89504e470d0a1a0a';

interface Icon { src: string; sizes: string; type: string }

/** The `pwa { }` block, or null when the app has none. */
export function readPwa(root: string): ConfigBlock | null {
  try { const block = readMutenConfig(root).pwa; return block && typeof block === 'object' && !Array.isArray(block) ? block : null; } catch { return null; }
}

const text = (block: ConfigBlock, key: string): string => (typeof block[key] === 'string' ? String(block[key]) : '');

/** A PNG's width × height from its header, or '' when the file is not a PNG. */
export function pngSize(file: string): string {
  try {
    const head = readFileSync(file).subarray(0, 24);
    if (head.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return '';
    return `${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
  } catch { return ''; }
}

/** The manifest's icons: each listed file, at the path it is served from (public/ is the site's root), with its size. */
export function pwaIcons(root: string, block: ConfigBlock): Icon[] {
  const listed = Array.isArray(block.icons) ? block.icons.filter((icon): icon is string => typeof icon === 'string') : text(block, 'icon') ? [text(block, 'icon')] : [];
  return listed.filter((path) => existsSync(join(root, path))).map((path) => {
    const served = '/' + relative(join(root, 'public'), join(root, path)).split(sep).join('/');
    if (path.endsWith('.svg')) return { src: served, sizes: 'any', type: 'image/svg+xml' };
    return { src: served, sizes: pngSize(join(root, path)) || 'any', type: 'image/png' };
  });
}

/** The tags index.html gets: the manifest, the theme color, and the worker's registration when offline. */
export function pwaHead(root: string): string {
  const block = readPwa(root);
  if (!block) return '';
  const color = text(block, 'color');
  return [`<link rel="manifest" href="/${MANIFEST}">`, color ? `<meta name="theme-color" content="${color.replace(/"/g, '')}">` : '', block.offline === true ? `<script src="/${REGISTER}" defer></script>` : ''].filter(Boolean).join('\n  ');
}

/** The service worker, storing `precache` at install. */
function workerSource(cache: string, precache: string[]): string {
  return `// muten pwa { offline true }: pages network first, hashed assets cache first, one cache per build.
const CACHE = ${JSON.stringify(cache)};
const PRECACHE = ${JSON.stringify(precache)};
self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('muten-') && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); return response; })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('/'))));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((response) => { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)); return response; })));
  }
});
`;
}

/** Writes the manifest, and with `offline` the worker and its registration. `metafile` (a bundle's) says what the app
 *  opens with, to store at install; without it (muten build) only the first page is stored, the rest as it is visited. */
export function writePwa(root: string, outDir: string, metafile: Metafile | null, css: string[], say: (line: string) => void): void {
  const block = readPwa(root);
  if (!block) return;
  const title = /<title>([^<]*)<\/title>/i.exec(existsSync(join(root, 'index.html')) ? readFileSync(join(root, 'index.html'), 'utf8') : '')?.[1] || '';
  const name = text(block, 'name') || title || 'App';
  const icons = pwaIcons(root, block);
  const manifest = {
    name, short_name: text(block, 'short') || name, start_url: '/', scope: '/', display: text(block, 'display') || 'standalone',
    ...(text(block, 'color') ? { theme_color: text(block, 'color') } : {}), background_color: text(block, 'background') || '#ffffff', icons,
  };
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifest, null, 2));
  const sizes = icons.map((icon) => icon.sizes);
  const has = (size: number): boolean => sizes.includes('any') || sizes.some((one) => Number(one.split('x')[0]) >= size);
  if (!has(192) || !has(512)) say('  \x1b[33m!\x1b[0m pwa: a phone offers to install the app only with a 192 px and a 512 px icon: `icons ["public/icon-192.png", "public/icon-512.png"]`');
  if (block.offline !== true) { say(`  pwa: ${MANIFEST} (installable)`); return; }
  const boot = metafile ? bootOutput(metafile) : undefined;
  const opening = boot && metafile ? [...closure(metafile, boot, new Set())].filter((file) => file.endsWith('.js')).map((file) => '/' + relative(outDir, file).split(sep).join('/')) : [];
  const precache = ['/', ...opening, ...css];
  const cache = 'muten-' + createHash('sha256').update(precache.join('|') + Date.now()).digest('hex').slice(0, 10);
  writeFileSync(join(outDir, WORKER), workerSource(cache, precache));
  writeFileSync(join(outDir, REGISTER), `if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('/${WORKER}').catch(() => {}); });\n`);
  say(`  pwa: ${MANIFEST} + ${WORKER} (installable, opens offline: ${precache.length} files stored at install)`);
}
