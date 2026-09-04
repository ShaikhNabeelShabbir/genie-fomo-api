import { Pool } from "pg";

/**
 * The Postgres pool.
 *
 * Reads SUPABASE_DB_URL (session pooler, port 5432) or DATABASE_URL (transaction pooler,
 * 6543). Either works for the read queries here; 6543 is the better fit for an app because
 * it does not hold a session per connection.
 *
 * Note for whoever moves this to `node-postgres` prepared statements later: the transaction
 * pooler does not support them, so statement caching has to stay off on 6543.
 */
const url = (process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? "").trim();

export const haveDb = (): boolean => !!url;

let pool: Pool | null = null;

export function db(): Pool {
  if (!url) throw new Error("neither SUPABASE_DB_URL nor DATABASE_URL is set");
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      // Supabase terminates TLS at the pooler with a cert this client will not chain to.
      ssl: { rejectUnauthorized: false },
    });
    // A pool error with no listener takes the process down. A dropped idle connection is
    // routine on a pooler and must not be fatal.
    pool.on("error", (e) => console.error(`pg pool: ${e.message}`));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
