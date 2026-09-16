import { match, requestVersion, rewriteVersion } from "./router.ts";
import type { ApiVersion } from "./router.ts";
import { ApiError, classify, unauthorized, checkRate } from "./errors.ts";
import type { RateState } from "./errors.ts";
import { cfg } from "./config.ts";
import "./routes.ts";

/**
 * genie-fomo API: the request handler.
 *
 * Serves the PARAMETERS.md parameters straight from Postgres. Nothing here calls fomoapi,
 * Helius, Bitquery or Etherscan — those keys belong to the scheduled loaders, so a request
 * costs a query and nothing else, and a thousand visitors cost what one does.
 *
 * Runtime-neutral: `index.ts` (Deno) and `worker/src/api.ts` (Workers) both serve `handle`.
 */
/** A batch is capped at 50, so a single call can never cost more than that. */
const BATCH_MAX_COST = 50;

const headers = (extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  // A browser client cannot read these unless they are exposed.
  "Access-Control-Expose-Headers":
    "Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Scope, x-request-id",
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

/** Every response is serialised here, compact (pretty-printing was 1.5-2x the bytes on batch bodies), with the requested API version applied to its links once. */
const json = (body: unknown, status = 200, extra: Record<string, string> = {}, version: ApiVersion = "v1") =>
  new Response(rewriteVersion(JSON.stringify(body), version), { status, headers: headers(extra) });

/**
 * A per-request id, echoed on every error and in the `x-request-id` header.
 *
 * Without one, "it failed around 3pm" is the whole bug report. A consumer can now quote an
 * id and we can find that exact request. Generated per request, never reused.
 */
const requestId = () => `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

const fail = (e: ApiError, extra: Record<string, string> = {}, version: ApiVersion = "v1", rid = requestId()) =>
  json(
    {
      error: {
        // Stable and machine-readable. Status alone cannot tell "no such trader" from
        // "no such route", and both are 404.
        code: e.code,
        detail: e.message,
        /** Quote this when reporting a failure; it identifies the exact request. */
        requestId: rid,
        ...(e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
        ...(e.extra ?? {}),
      },
    },
    e.status,
    { ...extra, "x-request-id": rid,
      ...(e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {}) },
    version,
  );

/** The bucket key for a caller. See docs/DECISIONS.md#d011 */
const callerKey = (req: Request): string => {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) return `key:${apiKey}`;
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const client = fwd.split(",")[0].trim();
  return client ? `ip:${client}` : "anon";
};

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers() });
  const KEY = (cfg("GENIE_API_KEY") ?? "").trim();
  const RATE_LIMIT = Number(cfg("RATE_LIMIT_PER_MINUTE") ?? 240);
  /** No route may hang. See docs/DECISIONS.md#d010 */
  const ROUTE_TIMEOUT_MS = Number(cfg("ROUTE_TIMEOUT_MS") ?? 15000);

  const url = new URL(req.url);
  const version = requestVersion(url.pathname);
  let rate: RateState | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
          "GET /traders/:handle/trades",
          "GET /traders/:handle/aum",
          "GET /traders/:handle/flow?since=<iso>",
          "GET /tokens",
          "GET /tokens/momentum",
          "GET /tokens/:address",
          "GET /tokens/:address/activity",
          "GET /creators/:address",
          "GET /chains",
          "GET /market/regime",
          "GET /events?since=&cursor=&kind=&chain=&handle=",
          "GET /fields",
          "POST /traders/positions   { ids: [...] }",
          "POST /traders/aum        { ids: [...], window, step }",
          "POST /traders/flow       { ids: [...], since }",
          "POST /traders/:handle/wallets   { secret, evmAddress?, solanaAddress? }",
        ],
      });
    }

    // POST carries a JSON body; GET never does.
    let body: unknown = null;
    if (req.method === "POST") {
      try { body = await req.json(); }
      catch { throw new ApiError(400, "bad_request", "body must be JSON"); }
    }

    /*
     * Every route is bounded.
     *
     * A 30-second hang with no body is indistinguishable from a slow success, and a
     * consumer cannot tell whether to wait, retry or give up. Losing the race returns a
     * 503 with `code: "timeout"` -- an answer, and an actionable one.
     */
    const answered = await Promise.race([
      Promise.resolve(hit.handler(hit.params, url, body)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ApiError(503, "timeout",
          `this route did not answer within ${ROUTE_TIMEOUT_MS / 1000}s — retry`,
          undefined, 5)), ROUTE_TIMEOUT_MS);
      }),
    ]);
    /** COST IS WHAT THE CALL ACTUALLY ASKED FOR, not a flat 1. See docs/DECISIONS.md#d012 */
    const asked = (answered as { asked?: unknown } | null)?.asked;
    const cost = typeof asked === "number" && Number.isFinite(asked) && asked > 0
      ? Math.min(asked, BATCH_MAX_COST)
      : 1;
    return json(answered, 200, { ...rateHeaders(rate), "x-cost-units": String(cost) }, version);
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
    return fail(err, rateHeaders(rate), version);
  } finally {
    // A route that answered early must not leave its timer holding the isolate open.
    clearTimeout(timer);
  }
}
