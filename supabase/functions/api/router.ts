/** Tiny path router — Deno has no Express, and one function serves every route. */
export type Handler = (
  params: Record<string, string>,
  url: URL,
) => Promise<unknown> | unknown;

type Route = { method: string; parts: string[]; handler: Handler };
const routes: Route[] = [];

export function get(pattern: string, handler: Handler): void {
  routes.push({ method: "GET", parts: pattern.split("/").filter(Boolean), handler });
}

/**
 * Match a path, preferring literal segments over parameters.
 *
 * Declaration order is NOT the tiebreak, deliberately. `/v1/tokens/momentum` and
 * `/v1/tokens/:address` are the same shape, and with first-match-wins the literal route is
 * unreachable if it happens to be declared second — which is exactly the bug this hit:
 * `momentum` resolved as a token address and returned "no leader holds 'momentum'".
 * Scoring by specificity makes the outcome independent of the order things are written in.
 */
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
