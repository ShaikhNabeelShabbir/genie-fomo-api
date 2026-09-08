import { match } from "./router.ts";
import { ApiError, classify, unauthorized, checkRate } from "./errors.ts";
import type { RateState } from "./errors.ts";
import "./routes.ts";

/**
 * genie-fomo API as a Supabase Edge Function.
 *
 * Serves the PARAMETERS.md parameters straight from Postgres. Nothing here calls fomoapi,
 * Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders, so a request
 * costs a query and nothing else, and a thousand visitors cost what one does.
 */
const KEY = (Deno.env.get("GENIE_API_KEY") ?? "").trim();
const RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT_PER_MINUTE") ?? 240);
const port = Number(Deno.env.get("PORT") ?? 8000);

const headers = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  // A browser client cannot read these unless they are exposed.
  "Access-Control-Expose-Headers":
    "Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Scope",
  ...extra,
});

const rateHeaders = (r: RateState | null): Record<string, string> =>
  r
    ? {
        "RateLimit-Limit": String(r.limit),
        "RateLimit-Remaining": String(r.remaining),
        "RateLimit-Reset": String(r.reset),
        // Per instance, not global — see RateState. Without this a client would pace against
        // a budget that appears to reset whenever it reaches a different instance.
        "RateLimit-Scope": r.scope,
      }
    : {};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: headers(extra) });

const fail = (e: ApiError, extra: Record<string, string> = {}) =>
  json(
    {
      error: {
        // Stable and machine-readable. Status alone cannot tell "no such trader" from
        // "no such route", and both are 404.
        code: e.code,
        detail: e.message,
        ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
        ...(e.extra ?? {}),
      },
    },
    e.status,
    { ...extra, ...(e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {}) },
  );

/**
 * The bucket key for a caller.
 *
 * `x-forwarded-for` is a CHAIN — `client, proxy1, proxy2` — and only the leftmost entry is
 * the original caller. Using the whole header made the key move as intermediate hops
 * changed: eight anonymous calls in a row produced 239, 239, 239, 238, 237, 238, 239, 236,
 * because they were landing in several different buckets. The first entry is stable.
 *
 * Note it is also client-supplied and therefore spoofable; this is a fair-use guard, not a
 * security control, and the leftmost-entry rule is what makes it work for honest clients.
 */
const callerKey = (req: Request): string => {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return `key:${apiKey}`;
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const client = fwd.split(",")[0].trim();
  return client ? `ip:${client}` : "anon";
};

Deno.serve({ port }, async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });

  const url = new URL(req.url);
  let rate: RateState | null = null;
  try {
    // Rate limit before auth so a flood of bad keys cannot be used to hammer the database.
    rate = await checkRate(callerKey(req));

    if (KEY && req.headers.get("x-api-key") !== KEY) throw unauthorized();

    const hit = match(req.method, url.pathname);
    if (!hit) {
      // A 404 that lists what DOES exist. Both 404s reported in review were URL shape,
      // not a missing feature — an error that names the alternatives ends that class.
      throw new ApiError(404, "not_found", `no route for ${req.method} ${url.pathname}`, {
        hint: "the handle is a parameter, not the first segment: /traders/<handle>/wallets",
        routes: [
          "GET /health",
          "GET /traders",
          "GET /traders/:handle",
          "GET /traders/:handle/pnl",
          "GET /traders/:handle/scorecard",
          "GET /traders/:handle/portfolio",
          "GET /traders/:handle/positions",
          "GET /traders/:handle/trust",
          "GET /traders/:handle/wallets",
          "GET /traders/:handle/transactions",
          "GET /tokens",
          "GET /tokens/momentum",
          "GET /tokens/:address",
          "GET /tokens/:address/activity",
          "GET /chains",
        ],
      });
    }
    return json(await hit.handler(hit.params, url), 200, rateHeaders(rate));
  } catch (e) {
    const err = classify(e);
    if (err.status >= 500) console.error(`${url.pathname}: ${err.code} ${err.message}`);
    // Errors carry the budget too — a 404 while nearly exhausted is worth knowing about
    // before the next call turns into a 429. On a 429 `rate` is null, because checkRate
    // threw instead of returning: reconstruct the state so the response that most needs
    // the budget is not the one response missing it.
    if (!rate && err.status === 429) {
      rate = { limit: RATE_LIMIT, remaining: 0, reset: err.retryAfterSeconds ?? 60, scope: "global" };
    }
    return fail(err, rateHeaders(rate));
  }
});
