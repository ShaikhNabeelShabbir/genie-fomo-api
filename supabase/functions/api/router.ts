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
export function match(method: string, pathname: string) {
  // Strip the function name Supabase prefixes onto the path (/api/v1/... -> /v1/...).
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  // Supabase already serves this function under /functions/v1/api, so writing the routes
  // out in full means a double `v1`: /functions/v1/api/v1/traders. That reads like a typo
  // and gets typed as one, so the version segment is optional here — both forms resolve.
  if (parts[0] !== "v1") parts.unshift("v1");

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
