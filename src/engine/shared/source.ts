import type { Value } from '#engine/shared/types.js';

// source: data-source semantics for queries, defined once for both build and runtime.
// The build (SSG fetch, app graph) and the browser data layer (compile/emit.ts, inlined
// via Function.prototype.toString) share this code verbatim so they never drift apart.
// Security: header values ship to the client. Use public API keys or per-user runtime tokens.

export interface SourceRequest {
  url: string;
  method: string;                  // upper-cased, defaults to GET
  headers: { [k: string]: string };
  body: string | null;             // JSON-serialized request body (POST/PUT/PATCH), null otherwise
  at: string | null;               // JSON path to the array within the response (e.g. "data")
  wait: boolean;                   // `wait: true`: no load on its own — the query waits for its first refetch (its params)
  credentials: string;             // fetch credentials: 'include' sends the backend's httpOnly session cookie ('' = browser default)
}

// Normalize a raw source descriptor (URL string or request object) into a complete request,
// applied against the app-wide `api` config. Two shapes of `api` (app.muten):
//   flat   `api { base, headers }`        -> the single backend
//   named  `api { shop: {...}, cms: {...} }` -> many backends; a source picks one with `{ api: "shop" }`
//                                             (no pick -> the client literally named `default`)
// Source's own url/headers override the client's. Absolute url ignores `base`; relative joins it.
// Must be self-contained: the runtime inlines this via toString(), so no helper may escape its body.
export function sourceRequest(src: Value, api: Value = {}): SourceRequest {
  const str = (v: Value | undefined): string => (typeof v === 'string' ? v : '');
  const obj = (v: Value | undefined): { [k: string]: Value } => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const apiObj = obj(api);
  const s = obj(src);
  // flat config (`base`/`headers` at top) = single client; otherwise a map keyed by client name
  const flat = 'base' in apiObj || 'headers' in apiObj || 'credentials' in apiObj;
  const client = obj(flat ? apiObj : apiObj[str(s.api) || 'default']);
  const base = typeof client.base === 'string' ? client.base : '';
  // \`api { credentials "include" }\`: the session lives in an httpOnly cookie the backend sets, which no script can read
  // (an XSS cannot steal it); the browser sends it with every request to that backend.
  const credentials = client.credentials === 'include' || client.credentials === 'same-origin' || client.credentials === 'omit' ? client.credentials : '';
  const join = (u: string): string => {
    if (!u) return base;                                              // no url -> bare base
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.indexOf('//') === 0) return u; // absolute (scheme:// or //host)
    if (!base) return u;                                              // relative but no base -> as-is
    return base.replace(/\/+$/, '') + '/' + u.replace(/^\/+/, '');    // join, collapsing the slash seam
  };
  const headers: { [k: string]: string } = {};
  const collect = (h: Value | undefined): void => { for (const [k, v] of Object.entries(obj(h))) if (typeof v === 'string') headers[k] = v; };
  collect(client.headers);                                            // client defaults first
  if (typeof src === 'string') return { url: join(src), method: 'GET', headers, body: null, at: null, wait: false, credentials };
  collect(s.headers);                                                 // per-source headers override last
  const hasBody = s.body !== undefined && s.body !== null;
  return { url: join(str(s.url)), method: (str(s.method) || 'GET').toUpperCase(), headers, body: hasBody ? JSON.stringify(s.body) : null, at: str(s.at) || null, wait: s.wait === true, credentials };
}

// Pick the row array from a fetched JSON response: walk the dotted `at` path (e.g. "data.posts" for
// GraphQL/nested envelopes) when set, else the response itself is the array.
export function sourceRows(json: Value, at: string | null): Value[] {
  let picked: Value = json;
  if (at) for (const key of at.split('.')) picked = picked !== null && typeof picked === 'object' && !Array.isArray(picked) ? picked[key] : null;
  return Array.isArray(picked) ? picked : [];
}
