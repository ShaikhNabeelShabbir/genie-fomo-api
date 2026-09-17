import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";

/**
 * Rebuild `position_timing` from `transactions`: the Worker half of refresh.yml
 * "Refresh position timing".
 *
 * Ported from `scripts/refresh_position_timing.mjs` (deleted 17 Sep 2026; the Worker is the only copy). Same figures,
 * one wallet at a time: D1 allows a statement 30 s, which the whole-table aggregate (and so the
 * build-beside-then-swap around it) could never hold to. A wallet's rows are deleted and rebuilt
 * in ONE batch, so a reader — `/positions` reads `position_timing` by `address_key` — never sees
 * a half-rebuilt wallet. A pass that finishes ends by dropping what it did not rewrite, which is
 * what the table swap did; a pass the budget cuts short leaves the untouched wallets alone and
 * says how many are left, and the next run redoes the lot (every step is idempotent).
 */

export interface TimingSummary {
  /** Distinct wallets rebuilt; on a complete pass, the wallets in the table. */
  readonly traders: number;
  /** Rows rebuilt; on a complete pass, the rows in the table. */
  readonly rows: number;
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/** Every wallet in `transactions`, one index seek each (a loose index scan), never a table scan. */
const wallets = (sql: Sql) => sql<{ address_key: string }[]>`
  with recursive w(address_key) as (
    select min(address_key) from transactions
    union all
    select (select min(address_key) from transactions t where t.address_key > w.address_key)
      from w where w.address_key is not null
  )
  select address_key from w where address_key is not null`;

/**
 * One wallet: its old rows out and its rebuilt rows in, as one atomic batch. `position_timing.last_at`
 * is NOT NULL, so a (wallet, token) whose transfers all lack a `block_time` is left out rather
 * than written with a null. Returns the rows the wallet now has.
 */
const rebuild = (sql: Sql, addressKey: string, computedAt: string): Promise<number> =>
  sql.begin(async (tx) => {
    void tx`delete from position_timing where address_key = ${addressKey}`;
    const written = await tx`
      insert into position_timing (address_key, network_id, token_key, start_at, end_at, last_at, computed_at)
      select address_key, network_id, token_key,
             min(case when direction = 'in' then block_time end),
             max(case when direction = 'out' then block_time end),
             max(block_time),
             ${computedAt}
        from transactions
       where address_key = ${addressKey}
       group by address_key, network_id, token_key
      having max(block_time) is not null`;
    return written.count;
  });

export async function runTiming(env: Env, budgetMs: number): Promise<TimingSummary> {
  const started = Date.now();
  if (budgetMs <= 0) return { traders: 0, rows: 0, remaining: 0, stoppedEarly: true, elapsedMs: 0 };
  const sql = jobSql(env);
  try {
    const computedAt = new Date(started).toISOString();
    const list = await wallets(sql);
    let traders = 0, rows = 0, done = 0, stoppedEarly = false;
    for (const w of list) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      const n = await rebuild(sql, w.address_key, computedAt);
      rows += n;
      if (n > 0) traders += 1;
      done += 1;
    }
    // What the table swap did: a complete pass leaves nothing behind for a wallet `transactions`
    // no longer carries, and every row it wrote carries this run's `computed_at`.
    if (!stoppedEarly) await sql`delete from position_timing where computed_at < ${computedAt}`;
    return { traders, rows, remaining: list.length - done, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
