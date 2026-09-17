import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { rpc, SOL_MINT, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { DENY, DUST_SOL, MIN_SOL, resolveCase } from "./wallets-core";

/**
 * Funded-wallet linker (workflow gap 5b, W-J), the Worker half of refresh.yml "Link funded
 * wallets". A native SOL transfer OUT of a tracked wallet to an untracked, unknown address
 * is a funding candidate; it becomes a `linked_wallets` row (`funded_by`) once the address
 * looks used: a second touch, or a first transfer of at least MIN_SOL. A second pass reads
 * the case-preserved spelling back from the evidence transaction (Helius refuses a
 * lowercased base58 address) so the row can join the webhook registration.
 *
 * Ported from `scripts/link_wallets.mjs` (deleted 17 Sep 2026; the Worker is the only copy). Same SQL and constants; differs only where
 * the platform does — a wall-clock budget checked before every insert and every RPC, a
 * failed unit is counted rather than fatal, the candidate scan is one D1 statement (there is
 * no `statement_timeout` to lift), and no `--dry-run`/`--min-sol` flags.
 */

interface Candidate {
  readonly handle: string; readonly from_key: string; readonly to_key: string;
  readonly tx_hash: string; readonly block_time: string | null; readonly amount: number; readonly touches: number;
}
interface Pending { readonly address_key: string; readonly evidence_tx: string }

/** Rows written without a spelling are retried each run, this many at a time. */
const PENDING_LIMIT = 200;

export interface WalletsSummary {
  /** New funding candidates the scan found this run. */
  readonly candidates: number;
  /** `linked_wallets` rows inserted. */
  readonly linked: number;
  /** Inserts or spelling lookups that failed; each is retried next run. */
  readonly errored: number;
  /** Candidates not inserted plus pending spellings not resolved. Zero means the pass was complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/* `distinct on (handle, to_key)` is `row_number() = 1`; Postgres's implicit ASC NULLS LAST is spelled `x is null, x`. */
const candidates = (sql: Sql) => sql<Candidate[]>`
  with tracked as (
    select handle, sol_address_key as k from wallets where sol_address_key is not null
  ),
  funding as (
    select w.handle, t.address_key as from_key, t.counterparty as to_key,
           t.tx_hash, t.block_time, t.amount
    from transactions t
    join tracked w on w.k = t.address_key
    where t.network_id = ${SOLANA_NETWORK_ID} and t.token_key = ${SOL_MINT} and t.direction = 'out'
      and t.counterparty is not null
      and t.amount >= ${DUST_SOL}
      and t.counterparty not in (${DENY})
      and not exists (select 1 from tracked x where x.k = t.counterparty)
  ),
  first_funding as (
    select handle, from_key, to_key, tx_hash, block_time, amount from (
      select handle, from_key, to_key, tx_hash, block_time, amount,
             row_number() over (partition by handle, to_key order by block_time is null, block_time) as rn
      from funding
    ) r where r.rn = 1
  ),
  touches as (
    select x.counterparty as k, count(*) as n
    from transactions x
    where x.network_id = ${SOLANA_NETWORK_ID} and x.counterparty in (select to_key from first_funding)
    group by x.counterparty
  )
  select f.handle, f.from_key, f.to_key, f.tx_hash, f.block_time, f.amount, coalesce(tc.n, 0) as touches
  from first_funding f
  left join touches tc on tc.k = f.to_key
  left join linked_wallets lw
    on lw.handle = f.handle and lw.network_id = ${SOLANA_NETWORK_ID} and lw.address_key = f.to_key
  where lw.address_key is null
    and (f.amount >= ${MIN_SOL} or coalesce(tc.n, 0) >= 2)
  order by f.handle, f.block_time is null, f.block_time`;

/** Returns 1 when the row was new, 0 when the primary key already held it. */
async function link(sql: Sql, r: Candidate): Promise<number> {
  const res = await sql`
    insert into linked_wallets
      (handle, network_id, address_key, linked_from_address_key, link_kind, first_seen_at, evidence_tx)
    values (${r.handle}, ${SOLANA_NETWORK_ID}, ${r.to_key}, ${r.from_key}, 'funded_by', ${r.block_time}, ${r.tx_hash})
    on conflict (handle, network_id, address_key) do nothing`;
  return res.count;
}

const pending = (sql: Sql) => sql<Pending[]>`
  select address_key, evidence_tx from linked_wallets
  where network_id = ${SOLANA_NETWORK_ID} and address is null and evidence_tx is not null limit ${PENDING_LIMIT}`;

/** Look the spelling up on Helius and store it. Returns 1 when resolved, 0 when the accounts do not carry it. */
async function resolve(sql: Sql, heliusKey: string, p: Pending): Promise<number> {
  const res: unknown = await rpc(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
    jsonrpc: "2.0", id: 1, method: "getTransaction",
    params: [p.evidence_tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
  });
  const address = resolveCase(res, p.address_key);
  if (!address) return 0;
  await sql`update linked_wallets set address = ${address} where network_id = ${SOLANA_NETWORK_ID} and address_key = ${p.address_key}`;
  return 1;
}

/**
 * One pass: link every new candidate, then resolve pending spellings, within `budgetMs`.
 * Throws only when units were attempted and every one failed, so the cron shows as failed.
 */
export async function runWallets(env: Env, budgetMs: number): Promise<WalletsSummary> {
  const started = Date.now();
  const heliusKey = (env.HELIUS_SOLANA_KEY ?? "").trim();
  const sql = jobSql(env);
  try {
    const rows = await candidates(sql);
    let linked = 0, attempted = 0, errored = 0, done = 0, stoppedEarly = false;
    for (const r of rows) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      attempted += 1;
      try {
        linked += await link(sql, r);
        done += 1;
      } catch (e) {
        errored += 1;
        console.error(`wallets: link ${r.handle} -> ${r.to_key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    /* Second pass, so a row written without a key (or whose lookup failed) is retried each run. */
    let pendingRows: Pending[] = [], resolved = 0;
    if (!heliusKey) {
      console.warn("wallets: HELIUS_SOLANA_KEY not set: unresolved rows stay off the webhook");
    } else if (!stoppedEarly) {
      pendingRows = await pending(sql);
      for (const p of pendingRows) {
        if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
        attempted += 1;
        try {
          resolved += await resolve(sql, heliusKey, p);
        } catch (e) {
          errored += 1;
          console.warn(`wallets: ${p.evidence_tx}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (attempted > 0 && errored === attempted) throw new Error(`wallets: all ${attempted} units failed`);
    return {
      candidates: rows.length, linked, errored,
      remaining: rows.length - done + pendingRows.length - resolved,
      stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
