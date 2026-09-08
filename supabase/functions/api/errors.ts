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
import { sql } from "./db.ts";

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
 * The rate limiter.
 *
 * This was a `Map` in module scope. That never worked: every Edge Function invocation gets
 * a fresh isolate, so the map arrived empty and was thrown away on exit. Measured: 132
 * consecutive calls each reported `remaining: 239`, and 400 calls never produced a 429. The
 * limit did not bind, and the header was a constant wearing a budget's clothing — worse
 * than no header, because a client would have paced against it.
 *
 * The counter now lives in Postgres, the one thing every instance shares, and is bumped in
 * a single atomic statement so two instances cannot interleave a read-modify-write.
 */
const WINDOW_SECONDS = 60;
const MAX_PER_WINDOW = Number(Deno.env.get("RATE_LIMIT_PER_MINUTE") ?? 240);

export type RateState = {
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  reset: number;
  /**
   * `global` when the shared counter answered, `unlimited` when it did not.
   *
   * The limiter fails OPEN: if the database is unreachable the request is served rather
   * than rejected. A rate limiter that turns a database blip into a site-wide outage has
   * done more damage than the traffic it was guarding against. `scope` says which happened,
   * so a header reading 240/240 is never mistaken for a fresh window.
   */
  scope: "global" | "unlimited";
};

const UNLIMITED: RateState = {
  limit: MAX_PER_WINDOW,
  remaining: MAX_PER_WINDOW,
  reset: WINDOW_SECONDS,
  scope: "unlimited",
};

/** Counts the request against the shared window and returns the state, or throws 429. */
export async function checkRate(key: string): Promise<RateState> {
  let row: { hit_count: number; reset_seconds: number } | undefined;
  try {
    [row] = await sql<{ hit_count: number; reset_seconds: number }[]>`
      select * from bump_rate_limit(${key}, ${WINDOW_SECONDS})
    `;
  } catch (e) {
    // Fail open, but say so out loud — a silently disabled limiter is how you find out
    // months later that it has been off the whole time.
    console.error(`rate limiter unavailable, allowing request: ${
      e instanceof Error ? e.message : String(e)
    }`);
    return UNLIMITED;
  }
  if (!row) return UNLIMITED;

  const count = Number(row.hit_count);
  const reset = Number(row.reset_seconds);
  if (count > MAX_PER_WINDOW) throw rateLimited(reset);
  return {
    limit: MAX_PER_WINDOW,
    remaining: Math.max(0, MAX_PER_WINDOW - count),
    reset,
    scope: "global",
  };
}
