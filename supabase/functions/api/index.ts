import { match } from "./router.ts";
import { ApiError, classify, unauthorized, checkRate } from "./errors.ts";
import "./routes.ts";

/**
 * genie-fomo API as a Supabase Edge Function.
 *
 * Serves the PARAMETERS.md parameters straight from Postgres. Nothing here calls fomoapi,
 * Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders, so a request
 * costs a query and nothing else, and a thousand visitors cost what one does.
 */
const KEY = (Deno.env.get("GENIE_API_KEY") ?? "").trim();
const port = Number(Deno.env.get("PORT") ?? 8000);

const headers = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Expose-Headers": "Retry-After",
  ...extra,
});

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: headers(extra) });

const fail = (e: ApiError) =>
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
      // Kept alongside `error` so existing callers reading `detail` do not break.
      detail: e.message,
    },
    e.status,
    e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {},
  );

Deno.serve({ port }, async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });

  const url = new URL(req.url);
  try {
    // Rate limit before auth so a flood of bad keys cannot be used to hammer the database.
    checkRate(req.headers.get("x-api-key") ?? req.headers.get("x-forwarded-for") ?? "anon");

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
    return json(await hit.handler(hit.params, url));
  } catch (e) {
    const err = classify(e);
    if (err.status >= 500) console.error(`${url.pathname}: ${err.code} ${err.message}`);
    return fail(err);
  }
});
