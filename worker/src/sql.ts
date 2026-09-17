import { d1sql, type Sql } from "./d1";
import type { Env } from "./env";

export type { Sql };

/**
 * The database handle every loader, the Helius receiver and the sampler use: Cloudflare D1
 * through the postgres.js-shaped shim (docs/D1_MIGRATION.md). No connection, no pool, no
 * `statement_timeout`; `sql.end()` is a no-op kept so callers read the same.
 */
export function jobSql(env: Env): Sql {
  if (!env.DB) throw new Error("D1 binding DB is not configured (wrangler.toml)");
  return d1sql(env.DB);
}
