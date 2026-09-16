/** Tiny path router — Deno has no Express, and one function serves every route. */
export type Handler = (
  params: Record<string, string>,
  url: URL,
  /** Parsed JSON body, for POST routes. `null` on GET. */
  body?: unknown,
) => Promise<unknown> | unknown;

type Route = { method: string; parts: string[]; handler: Handler };
const routes: Route[] = [];

export function get(pattern: string, handler: Handler): void {
  routes.push({ method: "GET", parts: pattern.split("/").filter(Boolean), handler });
}

/**
 * POST, for the batch reads.
 *
 * These are reads, not writes -- a list of ids will not fit in a query string once it is
 * fifty long, and a GET with a 2KB URL breaks proxies and logs. Nothing here mutates.
 */
export function post(pattern: string, handler: Handler): void {
  routes.push({ method: "POST", parts: pattern.split("/").filter(Boolean), handler });
}

/** Match a path, preferring literal segments over parameters. See docs/DECISIONS.md#d013 */
/**
 * The API versions a path may carry. `v1` is the Supabase deployment's contract; `v2` is the
 * same routes served by the Cloudflare Worker. Handlers are registered once under `v1` and
 * answer both; the version only decides how links in the response are spelled.
 */
export type ApiVersion = "v1" | "v2";
const VERSIONS: ReadonlySet<string> = new Set<ApiVersion>(["v1", "v2"]);

/** The version a request asked for; `v1` when the path carries none. */
export function requestVersion(pathname: string): ApiVersion {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  return VERSIONS.has(parts[0]) ? (parts[0] as ApiVersion) : "v1";
}

/** Response text with every `/v1/` link spelled for the requested version. Pure. */
export function rewriteVersion(text: string, version: ApiVersion): string {
  return version === "v1" ? text : text.replace(/\/v1\//g, `/${version}/`);
}

export function match(method: string, pathname: string) {
  // Strip the function name Supabase prefixes onto the path (/api/v1/... -> /v1/...).
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  // Supabase already serves this function under /functions/v1/api, so writing the routes
  // out in full means a double `v1`: /functions/v1/api/v1/traders. That reads like a typo
  // and gets typed as one, so the version segment is optional here — both forms resolve.
  // A `v2` path matches the same registrations (see ApiVersion).
  if (VERSIONS.has(parts[0])) parts[0] = "v1";
  else parts.unshift("v1");

  let best: { handler: Handler; params: Record<string, string>; score: number } | null = null;
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true, score = 0;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p === parts[i]) score++;
      else { ok = false; break; }
    }
    if (ok && (!best || score > best.score)) best = { handler: r.handler, params, score };
  }
  return best ? { handler: best.handler, params: best.params } : null;
}
