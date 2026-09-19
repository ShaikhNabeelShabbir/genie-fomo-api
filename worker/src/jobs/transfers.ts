import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { transferKey } from "../../../supabase/functions/_shared/md5.ts";
import { REFUSALS_IN_A_ROW, UA } from "../../../supabase/functions/_shared/settings.ts";
import { fetchTransactions, type ProviderKeys } from "../../../supabase/functions/_shared/transactions.ts";
import { SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { type Row, type Wallet, chunk, dedupe, isSourceRefusal, pickWebhook, toRows, walkBackTargets, webhooksOf } from "./transfers-core";

/**
 * On-chain transfer refresh, the Worker half of refresh.yml steps 6 and 7:
 * `backfill_transactions.mjs --pages 5 --fanout 3`, then `register_webhook.mjs`.
 *
 * Same fetch (`_shared/transactions.ts`, twin of scripts/lib/ts), same rows, same insert with
 * `transfer_key` computed by `_shared/md5.ts` exactly as the migration and webhook.ts write it. Differs only
 * where the platform does: wallets are taken STALEST FIRST (by the newest row a backfill wrote
 * for either of their addresses; webhook rows do not count) so a run cut short by the budget
 * resumes where the last one stopped, and a failed wallet is counted rather than fatal.
 */

const PAGES = 5;
const FANOUT = 3;
/** Wallets walked back per run: 3 x PAGES Helius calls an hour, where it used to be every wallet's. */
const WALK_BACK_PER_RUN = 3;
const LIMIT = 200;
/** 13 binds a row and D1 allows 100 a statement, so a statement carries 6 rows. */
const INSERT_ROWS = 6;
/** Rows per transaction: 50 statements in one `db.batch`. */
const INSERT_CHUNK = INSERT_ROWS * 50;
/** Kept back from phase 1 so the watch-list sync (two small Helius calls) always runs. */
const SYNC_RESERVE_MS = 30_000;
const HELIUS_WEBHOOKS = "https://api.helius.xyz/v0/webhooks";
/** The Worker's own receiver. It was the Supabase function until that project was sunset (19 Sep 2026); `WEBHOOK_URL` in wrangler.toml says the same. */
const DEFAULT_WEBHOOK_URL = "https://genie-copy-trading-api.agent-73b.workers.dev/webhook";

export interface TransfersSummary {
  /** Wallets attempted this run. */
  readonly wallets: number;
  /** Provider pages walked per chain per wallet (the `--pages` depth). */
  readonly pages: number;
  readonly rowsUpserted: number;
  /** Solana addresses now registered with Helius; null when the sync did not run or failed. */
  readonly watchlistSynced: number | null;
  /** Wallets whose fetch or insert failed; they stay stalest and lead the next run. */
  readonly errored: number;
  /** Wallets not attempted because the budget ran out. Zero means the pass was complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

/**
 * Every wallet with an address, longest-unpulled first (`wallets.transfers_pulled_at`, stamped by
 * this job), never-pulled first, then directory rank. The order used to be computed from
 * `max(transactions.ingested_at)` per wallet, which read all 1.29 M transfers every run.
 * ponytail: a wallet with genuinely no activity is re-asked every pass; one Helius call now, not five.
 */
const selectTargets = (sql: Sql) => sql<Wallet[]>`
  select w.handle, w.evm_address, w.sol_address, w.sol_backfill_done,
         -- W2: the oldest Solana signature we hold IS the next 'before'; no cursor column needed.
         (select t.tx_hash from transactions t
           where t.address_key = w.sol_address_key and t.network_id = ${SOLANA_NETWORK_ID}
           order by t.block_time asc limit 1)                        as sol_oldest_signature,
         -- The newest one a PULL stored is where the next pull stops. Not the webhook's: it can
         -- miss a delivery, and the pull is what closes that gap.
         (select t.tx_hash from transactions t
           where t.address_key = w.sol_address_key and t.network_id = ${SOLANA_NETWORK_ID}
             and t.source <> 'helius-webhook'
           order by t.block_time desc limit 1)                       as sol_newest_pulled_signature
    from wallets w join trader_stats_current s using (handle)
   where (w.evm_address is not null or w.sol_address is not null)
   order by coalesce(w.transfers_pulled_at, '') asc, s.rank is null, s.rank`;

/** `transfer_key` is the md5 of (token, direction, counterparty, amount); SQLite has none, so `_shared/md5.ts` digests it. */
const keyed = (r: Row): unknown[] => [
  r[0], r[1], r[2],
  transferKey(r[6] as string | null, r[4] as string | null, r[5] as string | null, r[8] as number | null),
  r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11],
];

/**
 * A2 (v5 fixes, 17 Sep 2026). MARK THE TRADER WHEN WE INGEST A SOLANA TRANSFER.
 *
 * `aum_live_dirty` was written by the Helius receiver and the balances job, but not here — so
 * this backfill could land Solana rows that move a wallet's balance without anything marking
 * the trader. `holdings_live` rolls those rows forward, so the live figure was right only
 * because every caller paid for the roll-forward on every trader, moved or not.
 *
 * With this mark, "not in `aum_live_dirty`" means "no transfer we hold post-dates the balance
 * read", which is what lets the hourly catch-up value unmoved traders from `holdings_current`
 * and skip a roll-forward that can only produce zero (see valuation.ts refreshAumLiveUnmoved).
 */
async function markDirty(sql: Sql, handle: string): Promise<void> {
  await sql`
    insert into aum_live_dirty (handle, marked_at) values (${handle}, ${new Date().toISOString()})
    on conflict (handle) do update set marked_at = excluded.marked_at`;
}

/** One transaction: statements of `INSERT_ROWS` rows, all in one D1 batch. */
async function upsert(sql: Sql, rows: readonly Row[]): Promise<void> {
  await sql.begin((tx) => {
    for (const part of chunk(rows.map(keyed), INSERT_ROWS)) {
      void tx.unsafe(
        `insert into transactions
           (network_id, tx_hash, address_key, transfer_key, block_time, direction,
            counterparty, token_key, token_symbol, amount, source, tx_type, tx_source)
         values ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
         on conflict (network_id, tx_hash, address_key, transfer_key) do update set
           block_time = excluded.block_time, token_symbol = excluded.token_symbol,
           amount = excluded.amount, source = excluded.source,
           tx_type = coalesce(excluded.tx_type, transactions.tx_type),
           tx_source = coalesce(excluded.tx_source, transactions.tx_source),
           ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        part.flat(),
      );
    }
    return Promise.resolve();
  });
}

/**
 * Fetch one wallet on every chain and upsert its rows. Returns rows written.
 *
 * W2 (v5 fixes, 17 Sep 2026). TWO SOLANA PULLS, NOT ONE.
 *
 * The head pull is what this job always did: `before` unset, the newest PAGES x 100 signatures,
 * which keeps recent activity current. On its own it also meant the record NEVER reached past
 * the newest 500 signatures — on an airdrop-spammed wallet that is a few weeks, and a trader
 * active this morning had no stored Solana swap since 6 Aug.
 *
 * The second pull walks BACKWARDS from the oldest signature we already hold, one PAGES-deep
 * page a run, until Helius answers with nothing and `sol_backfill_done` is set. A wallet is
 * finished once and never walked again.
 */
async function backfillWallet(sql: Sql, keys: ProviderKeys, w: Wallet): Promise<{ rows: number; refused: boolean }> {
  // includeNative pulls the native SOL side of a swap; without it a spend cannot be attributed.
  const out = await fetchTransactions(keys, w.evm_address, w.sol_address, null, LIMIT,
    { pages: PAGES, includeNative: true, solanaUntil: w.sol_newest_pulled_signature ?? null });
  for (const c of out.chains) if (c.error) console.error(`transfers: ${w.handle} ${c.chain}: ${c.error}`);
  const rows = dedupe(toRows(w, out.transfers));
  for (const part of chunk(rows, INSERT_CHUNK)) await upsert(sql, part);
  // With `solanaUntil` the Solana rows here are NEW ones, so this marks a trader who moved — it
  // used to mark every Solana trader every hour, which kept the 5-minute flush permanently full.
  await markIfSolana(sql, w, rows);
  // Stamped only when every chain answered: a refused pull must stay first in line.
  if (!out.chains.some((c) => c.error)) {
    await sql`update wallets set transfers_pulled_at = ${new Date().toISOString()} where handle = ${w.handle}`;
  }
  return { rows: rows.length, refused: out.chains.some((c) => isSourceRefusal(c.error)) };
}

/** Mark the trader when any of the rows just written is a Solana transfer. */
async function markIfSolana(sql: Sql, w: Wallet, rows: readonly Row[]): Promise<void> {
  if (rows.some((r) => r[0] === SOLANA_NETWORK_ID)) await markDirty(sql, w.handle);
}

/** One backward Solana page for a wallet whose history is not yet in. Returns rows written, or null when Helius refused. */
async function walkBack(sql: Sql, keys: ProviderKeys, w: Wallet): Promise<number | null> {
  const before = w.sol_oldest_signature ?? null;
  if (!w.sol_address || w.sol_backfill_done === 1 || before === null) return 0;
  const out = await fetchTransactions(keys, null, w.sol_address, ["solana"], LIMIT,
    { pages: PAGES, includeNative: true, solanaBefore: before });
  const sol = out.chains.find((c) => c.chain === "solana");
  if (sol?.error) {
    console.error(`transfers: ${w.handle} solana backfill: ${sol.error}`);
    return null;
  }
  const rows = dedupe(toRows(w, out.transfers));
  for (const part of chunk(rows, INSERT_CHUNK)) await upsert(sql, part);
  await markIfSolana(sql, w, rows);
  /* Helius ran out of signatures rather than out of pages: this wallet is done for good. */
  if (sol?.exhausted) {
    await sql`update wallets set sol_backfill_done = 1 where handle = ${w.handle}`;
  }
  return rows.length;
}

/** Helius webhooks API; Cloudflare fronts it and 403s a bare client, hence the UA. */
async function heliusApi(key: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const r = await fetch(`${HELIUS_WEBHOOKS}${path}?api-key=${key}`, {
    ...init,
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(45_000),
  });
  if (!r.ok) throw new Error(`helius ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Point the single Helius webhook at the receiver with the current wallet list. Returns addresses watched. */
async function syncWatchlist(sql: Sql, env: Env): Promise<number> {
  const key = (env.HELIUS_SOLANA_KEY ?? "").trim();
  if (!key) throw new Error("HELIUS_SOLANA_KEY is not set");
  const secret = (env.HELIUS_WEBHOOK_SECRET ?? "").trim();
  const target = env.WEBHOOK_URL ?? DEFAULT_WEBHOOK_URL;
  const existing = webhooksOf(await heliusApi(key, ""));
  // Plus the wallets a trader funded from a known one, where the case-preserved spelling is
  // known: Helius refuses the lowercased key linked_wallets is keyed on.
  const rows = await sql<{ sol_address: string }[]>`
    select sol_address from wallets where sol_address is not null
    union select address from linked_wallets where watch = 1 and address is not null
    order by 1`;
  const body = JSON.stringify({
    webhookURL: target,
    transactionTypes: ["Any"],
    accountAddresses: rows.map((r) => r.sol_address),
    webhookType: "enhanced",
    // Without this the receiver cannot tell a Helius delivery from anyone who learned the URL.
    ...(secret ? { authHeader: secret } : {}),
  });
  if (!secret) console.warn("transfers: HELIUS_WEBHOOK_SECRET is not set — the endpoint will accept unsigned posts");
  const mine = pickWebhook(existing, target);
  const saved = mine
    ? await heliusApi(key, `/${mine.webhookID}`, { method: "PUT", body })
    : await heliusApi(key, "", { method: "POST", body });
  const [only] = webhooksOf([saved]);
  console.log(`transfers: ${mine ? "updated" : "created"} webhook ${only?.webhookID ?? "?"} -> ${target}, watching ${rows.length}, auth header ${secret ? "set" : "NOT SET"}`);
  return rows.length;
}

/**
 * Phase 1: backfill wallets stalest first, FANOUT at a time, until the list ends or the budget
 * (less the sync reserve) is spent. Phase 2: sync the Helius watch list. Throws only when
 * nothing at all could be done, so the cron shows as failed.
 */
export async function runTransfers(env: Env, budgetMs: number): Promise<TransfersSummary> {
  const started = Date.now();
  const keys: ProviderKeys = {
    helius: (env.HELIUS_SOLANA_KEY ?? "").trim(),
    bitquery: (env.BITQUERY_KEY ?? "").trim(),
  };
  const sql = jobSql(env);
  try {
    const targets = await selectTargets(sql);
    let wallets = 0, rowsUpserted = 0, errored = 0, stoppedEarly = false, refusedInARow = 0;
    /*
     * HISTORY FIRST, A FEW WALLETS A RUN (19 Sep 2026). Walking back EVERY wallet on every hourly run
     * doubled this job's Helius calls the day it shipped, and two days later Helius answered 429 to
     * every balance read and swap batch. A page is five calls; the first refusal ends the walk.
     */
    for (const w of walkBackTargets(targets, WALK_BACK_PER_RUN)) {
      const walked = await walkBack(sql, keys, w);
      if (walked === null) break;
      rowsUpserted += walked;
    }
    for (let i = 0; i < targets.length; i += FANOUT) {
      if (Date.now() - started > budgetMs - SYNC_RESERVE_MS) { stoppedEarly = true; break; }
      const slice = targets.slice(i, i + FANOUT);
      const results = await Promise.allSettled(slice.map((w) => backfillWallet(sql, keys, w)));
      results.forEach((r, j) => {
        wallets += 1;
        if (r.status === "fulfilled") {
          rowsUpserted += r.value.rows;
          refusedInARow = r.value.refused ? refusedInARow + 1 : 0;
          // A chain the source refused is a failed wallet: it used to count as a success with 0 rows.
          if (r.value.refused) errored += 1;
          return;
        }
        errored += 1;
        console.error(`transfers: ${slice[j].handle} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      });
      if (refusedInARow >= REFUSALS_IN_A_ROW) {
        console.error(`transfers: a source refused ${refusedInARow} wallets in a row; leaving the rest of this run`);
        stoppedEarly = true;
        break;
      }
    }
    let watchlistSynced: number | null = null;
    try {
      watchlistSynced = await syncWatchlist(sql, env);
    } catch (e) {
      console.error(`transfers: watch-list sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (wallets > 0 && errored === wallets && watchlistSynced === null) {
      throw new Error(`transfers: all ${wallets} wallets failed and the watch list did not sync`);
    }
    return {
      wallets, pages: PAGES, rowsUpserted, watchlistSynced, errored,
      remaining: targets.length - wallets, stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
