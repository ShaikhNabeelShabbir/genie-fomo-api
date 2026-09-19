/** Typed errors, so a caller can tell apart the three cases that need different reactions: 40… See docs/DECISIONS.md#d005 */
import { sql } from "./db.ts";
import { cfg } from "./config.ts";

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

export const unavailable = (detail: string, retryAfter = 5) =>
  new ApiError(503, "unavailable", detail, undefined, retryAfter);

/** A sub-resource the caller explicitly asked for could not be produced. See docs/DECISIONS.md#d006 */
export const includeUnavailable = (blocks: string[]) =>
  new ApiError(
    503,
    "include_unavailable",
    `asked for ${blocks.join(", ")} but could not produce ${blocks.length === 1 ? "it" : "them"} — ` +
    `retry rather than treating this as "there is none"`,
    { blocks },
    5,
  );

/*
 * Three answers, and the order is the rule (19 Sep 2026). See docs/DECISIONS.md#d007
 *  1. OUR BUG — a statement SQLite rejects, a bind the shim refuses, a TypeError. The same request
 *     fails the same way every time, so it is a loud 500. It used to match `D1_ERROR` first and
 *     was served as 503 "retry shortly": /portfolio answered that for two days on a missing join.
 *  2. THE DATABASE IS BUSY OR WAS RESET — 503 with a longer Retry-After. It used to be 429
 *     `rate_limited` beside `RateLimit-Remaining: 240`, telling a caller with budget to spare that
 *     it had spent it. 429 now means one thing: the caller's own window (`rateLimited`).
 *  3. THE DATABASE IS NOT ANSWERING — 503, retry shortly.
 */
const OUR_BUG = /SQLITE_ERROR|SQLITE_CONSTRAINT|SQLITE_MISMATCH|D1_TYPE_ERROR|no such (?:column|table|function)|syntax error|too many SQL variables|^d1sql:/i;
const SATURATED = /SQLITE_BUSY|database is locked|overloaded|queued for too long|\breset\b|too many|ECHECKOUTTIMEOUT|max client connections|remaining connection slots/i;
const NOT_ANSWERING = /D1_ERROR|timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|connection|terminated|shutdown/i;
export const SATURATED_RETRY_SECONDS = 15;

/** Map anything thrown to a stable, documented code -- and never hand the caller driver text. */
export function classify(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const ours = e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || OUR_BUG.test(msg);
  if (!ours && SATURATED.test(msg)) {
    console.error("database saturated:", msg.slice(0, 200));
    return unavailable("the database is busy — retry after the stated delay", SATURATED_RETRY_SECONDS);
  }
  if (!ours && NOT_ANSWERING.test(msg)) {
    console.error("database unavailable:", msg.slice(0, 200));
    return unavailable("the database is not answering — retry shortly");
  }
  // Ours, or unknown: log the real thing, return a sentence a consumer can act on.
  console.error(ours ? "BUG (deterministic, will not heal on retry):" : "unhandled:", msg.slice(0, 400));
  return new ApiError(500, "internal_error", "the service failed to answer this request");
}

/** The rate limiter. See docs/DECISIONS.md#d008 */
const WINDOW_SECONDS = 60;
const maxPerWindow = () => Number(cfg("RATE_LIMIT_PER_MINUTE") ?? 240);

export type RateState = {
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  reset: number;
  /** `global` when the shared counter answered, `unlimited` when it did not. See docs/DECISIONS.md#d009 */
  scope: "global" | "unlimited";
};

const unlimited = (): RateState => ({
  limit: maxPerWindow(),
  remaining: maxPerWindow(),
  reset: WINDOW_SECONDS,
  scope: "unlimited",
});

/** The rate-limit write may take this long; past it the request is allowed through unmetered. */
export const RATE_CHECK_TIMEOUT_MS = 2000;

/** `checkRate`, bounded: a database too slow to count a request must not also delay it. */
export function checkRateWithin(key: string, ms: number): Promise<RateState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RateState>((resolve) => {
    timer = setTimeout(() => {
      console.error(`rate limiter did not answer within ${ms} ms, allowing request`);
      resolve(unlimited());
    }, ms);
  });
  return Promise.race([checkRate(key), expired]).finally(() => clearTimeout(timer));
}

/** Counts the request against the shared window and returns the state, or throws 429. */
export async function checkRate(key: string): Promise<RateState> {
  // bump_rate_limit() is gone with Postgres (worker/d1/SCHEMA_MAP.md): one atomic upsert keeps
  // the fixed window — the cutoff is computed here and bound, so the read-modify-write is still
  // a single statement and cannot interleave between instances.
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - WINDOW_SECONDS * 1000).toISOString();
  let row: { count: number; window_start: string } | undefined;
  try {
    [row] = await sql<{ count: number; window_start: string }[]>`
      insert into rate_limits (key, window_start, count) values (${key}, ${nowIso}, 1)
      on conflict (key) do update
        set count        = case when rate_limits.window_start < ${cutoff} then 1
                                else rate_limits.count + 1 end,
            window_start = case when rate_limits.window_start < ${cutoff} then ${nowIso}
                                else rate_limits.window_start end
      returning count, window_start
    `;
    // Keys are mostly client IPs, so the table would otherwise grow without bound. Pruning on
    // ~1% of calls keeps it small without needing a scheduled job (was inside the function).
    if (Math.random() < 0.01) {
      await sql`delete from rate_limits where window_start < ${new Date(nowMs - 600_000).toISOString()}`;
    }
  } catch (e) {
    // Fail open, but say so out loud — a silently disabled limiter is how you find out
    // months later that it has been off the whole time.
    console.error(`rate limiter unavailable, allowing request: ${
      e instanceof Error ? e.message : String(e)
    }`);
    return unlimited();
  }
  if (!row) return unlimited();

  const count = Number(row.count);
  const reset = Math.max(
    1,
    Math.ceil((Date.parse(String(row.window_start)) + WINDOW_SECONDS * 1000 - nowMs) / 1000),
  );
  if (count > maxPerWindow()) throw rateLimited(reset);
  return {
    limit: maxPerWindow(),
    remaining: Math.max(0, maxPerWindow() - count),
    reset,
    scope: "global",
  };
}
