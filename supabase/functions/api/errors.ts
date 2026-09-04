/**
 * Typed errors, so a caller can tell apart the three cases that need different reactions:
 *
 *   401 unauthorized  — the key is missing or wrong. STOP; retrying will not help.
 *   429 rate_limited  — back off and retry. `Retry-After` says how long.
 *   503 unavailable   — we are briefly down. Retry, and keep showing your last good copy.
 *
 * A single generic 500 forces a consumer to render "something went wrong" for all three,
 * which is exactly the complaint this exists to answer. Every error body carries a stable
 * machine-readable `code` alongside the human `detail`, because status alone cannot
 * distinguish "no such trader" from "no such route".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const notFound = (detail: string, extra?: Record<string, unknown>) =>
  new ApiError(404, "not_found", detail, extra);

export const badRequest = (detail: string, extra?: Record<string, unknown>) =>
  new ApiError(400, "bad_request", detail, extra);

export const unauthorized = () =>
  new ApiError(401, "unauthorized", "invalid or missing X-API-Key");

export const rateLimited = (retryAfter: number) =>
  new ApiError(429, "rate_limited", "too many requests — retry after the stated delay",
               undefined, retryAfter);

export const unavailable = (detail: string) =>
  new ApiError(503, "unavailable", detail, undefined, 5);

/**
 * Classify a thrown error.
 *
 * A database that is unreachable, out of connections or timing out is a RETRYABLE outage,
 * not a bug in the request — returning 500 for it tells the caller to give up when they
 * should be backing off and keeping their last good copy on screen.
 */
export function classify(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|connection|terminated|too many clients|shutdown/i.test(msg)) {
    return unavailable(`database unavailable: ${msg.slice(0, 120)}`);
  }
  return new ApiError(500, "internal_error", msg.slice(0, 200));
}

/**
 * A per-instance token bucket.
 *
 * Edge Functions scale horizontally, so this is not a global limit and is not pretending to
 * be one — it is a real 429 code path with a real Retry-After, so a consumer can build and
 * test their back-off against it instead of discovering the behaviour in production.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(Deno.env.get("RATE_LIMIT_PER_MINUTE") ?? 240);
const hits = new Map<string, { count: number; resetAt: number }>();

export function checkRate(key: string): void {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  rec.count++;
  if (rec.count > MAX_PER_WINDOW) {
    throw rateLimited(Math.max(1, Math.ceil((rec.resetAt - now) / 1000)));
  }
}
