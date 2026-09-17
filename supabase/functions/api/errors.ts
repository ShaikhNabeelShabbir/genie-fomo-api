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

export const unavailable = (detail: string) =>
  new ApiError(503, "unavailable", detail, undefined, 5);

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

/**
 * Classify a thrown error.
 *
 * A database that is unreachable, out of connections or timing out is a RETRYABLE outage,
 * not a bug in the request — returning 500 for it tells the caller to give up when they
 * should be backing off and keeping their last good copy on screen.
 */
/** Map anything thrown to a stable, documented code -- and never hand the caller driver text. See docs/DECISIONS.md#d007 */
export function classify(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const msg = e instanceof Error ? e.message : String(e);

  // Contention is BACK OFF, not "broken". 429 with Retry-After tells a client to pace
  // itself; a 500 tells it to give up, and a 503 tells it nothing actionable. D1 reports a
  // busy or overloaded database inside a `D1_ERROR:` wrapper, so this test runs first.
  if (/too many|SQLITE_BUSY|database is locked|overloaded|ECHECKOUTTIMEOUT|max client connections|remaining connection slots/i.test(msg)) {
    console.error("database saturated:", msg.slice(0, 200));
    return rateLimited(5);
  }
  if (/D1_ERROR|timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|connection|terminated|shutdown/i.test(msg)) {
    console.error("database unavailable:", msg.slice(0, 200));
    return unavailable("the database is not answering — retry shortly");
  }
  // Everything else: log the real thing, return a sentence a consumer can act on.
  console.error("unhandled:", msg.slice(0, 400));
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
