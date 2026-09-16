import postgres from "postgres";
import type { Env } from "./env";

/**
 * One client per request — bindings only exist inside the handler, and an I/O object reused
 * across requests throws. The caller closes it: `ctx.waitUntil(sql.end({ timeout: 5 }))`.
 * See docs/CLOUDFLARE_MIGRATION.md §4.3
 */
export function db(env: Env): postgres.Sql {
  if (!env.HYPERDRIVE) throw new Error("HYPERDRIVE binding is not configured (wrangler.toml)");
  return postgres(env.HYPERDRIVE.connectionString, {
    // Cloudflare's own example uses 5: Workers allow six simultaneous outbound connections,
    // and a route that does `Promise.all` over several queries wants more than one of them.
    max: 5,
    // `prepare` stays at its default (true): Hyperdrive over a DIRECT connection caches
    // named statements; `prepare: false` was for the 6543 transaction pooler (§4.2).
    fetch_types: false,
    /** 14 s, just under the 15 s route race (`ROUTE_TIMEOUT_MS`, app.ts): a timed-out route must not keep its query. */
    connection: { statement_timeout: 14000 },
  });
}
