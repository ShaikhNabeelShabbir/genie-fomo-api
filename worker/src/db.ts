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
    // `fetch_types` stays on: without the type fetch the driver cannot serialise arrays, and
    // every `= any(${list})` fails with "malformed array literal" (seen on the first deploy).
    /** 14 s, just under the 15 s route race (`ROUTE_TIMEOUT_MS`, app.ts): a timed-out route must not keep its query. */
    connection: { statement_timeout: 14000 },
  });
}

/**
 * Run `fn` on one connection whose `statement_timeout` is `ms` instead of the 14 s route
 * ceiling above: the nightly loaders ported to `jobs/*` carry statements (a transactions
 * scan, a 20k-row update) that the scripts ran under `statement_timeout = 0` or 2 min.
 * `set local` scopes it to this transaction, so the pooled connection comes back unchanged.
 */
export function longStatement<T>(sql: postgres.Sql, ms: number, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = ${Math.max(1, Math.floor(ms))}`);
    return fn(tx);
  }) as Promise<T>;
}
