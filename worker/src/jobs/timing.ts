import type { Env } from "../env";
import { db } from "../db";

/**
 * Rebuild `position_timing` from `transactions`: the Worker half of refresh.yml
 * "Refresh position timing".
 *
 * Ported from `scripts/refresh_position_timing.mjs` (deleted 18 Sep 2026; the Worker is the only copy). Same statements, same
 * build-beside-then-swap so the route never reads a half-filled table. Differs only where the
 * platform does: the rebuild runs inside ONE transaction, so `set local statement_timeout = 0`
 * beats the 14 s the client sets (db.ts) without touching session state on a pooled Hyperdrive
 * connection. The swap's exclusive lock on `position_timing` is still only taken at the end.
 * It is one set-based aggregate, so `remaining` is always 0 and `stoppedEarly` is only true
 * when no budget was left before the statement could start.
 */

export interface TimingSummary {
  /** Distinct wallets in the rebuilt table. */
  readonly traders: number;
  /** Rows in the rebuilt table. */
  readonly rows: number;
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

interface After { readonly rows: number; readonly wallets: number }

export async function runTiming(env: Env, budgetMs: number): Promise<TimingSummary> {
  const started = Date.now();
  if (budgetMs <= 0) return { traders: 0, rows: 0, remaining: 0, stoppedEarly: true, elapsedMs: 0 };
  const sql = db(env);
  try {
    const after = await sql.begin(async (tx): Promise<After> => {
      await tx`set local statement_timeout = 0`;
      await tx`drop table if exists position_timing_next`;
      await tx`
        create table position_timing_next as
        select address_key, network_id, token_key,
               min(block_time) filter (where direction = 'in')  as start_at,
               max(block_time) filter (where direction = 'out') as end_at,
               max(block_time)                                  as last_at,
               now()                                            as computed_at
        from transactions
        group by address_key, network_id, token_key`;
      await tx`alter table position_timing_next add primary key (address_key, network_id, token_key)`;
      await tx`create index on position_timing_next (address_key)`;
      await tx`drop table if exists position_timing_old`;
      await tx`alter table position_timing rename to position_timing_old`;
      await tx`alter table position_timing_next rename to position_timing`;
      await tx`drop table if exists position_timing_old`;
      const [row] = await tx<{ rows: number; wallets: number }[]>`
        select count(*)::int rows, count(distinct address_key)::int wallets from position_timing`;
      return { rows: Number(row?.rows ?? 0), wallets: Number(row?.wallets ?? 0) };
    });
    return { traders: after.wallets, rows: after.rows, remaining: 0, stoppedEarly: false, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
