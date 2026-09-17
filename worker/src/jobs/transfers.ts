import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { UA } from "../../../supabase/functions/_shared/settings.ts";
import { fetchTransactions, type ProviderKeys } from "../../../supabase/functions/_shared/transactions.ts";
import { type Row, type Wallet, chunk, dedupe, pickWebhook, toRows, webhooksOf } from "./transfers-core";

/**
 * On-chain transfer refresh, the Worker half of refresh.yml steps 6 and 7:
 * `backfill_transactions.mjs --pages 5 --fanout 3`, then `register_webhook.mjs`.
 *
 * Same fetch (`_shared/transactions.ts`, twin of scripts/lib/ts), same rows, same insert with
 * `transfer_key` computed in SQL exactly as the migration and webhook.ts write it. Differs only
 * where the platform does: wallets are taken STALEST FIRST (by the newest row a backfill wrote
 * for either of their addresses; webhook rows do not count) so a run cut short by the budget
 * resumes where the last one stopped, and a failed wallet is counted rather than fatal.
 */

type Sql = postgres.Sql;

const PAGES = 5;
const FANOUT = 3;
const LIMIT = 200;
/** 12 binds a row; Postgres allows 65,535 a statement. */
const INSERT_CHUNK = 5000;
/** Kept back from phase 1 so the watch-list sync (two small Helius calls) always runs. */
const SYNC_RESERVE_MS = 30_000;
const HELIUS_WEBHOOKS = "https://api.helius.xyz/v0/webhooks";
const DEFAULT_WEBHOOK_URL = "https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/helius-webhook";

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
 * Every wallet with an address, stalest first: the newest `ingested_at` a backfill (not the
 * webhook) wrote for either address, never-backfilled first, then directory rank.
 * ponytail: a wallet with genuinely no activity is re-fetched every run; fine at ~1 min a pass.
 */
const selectTargets = (sql: Sql) => sql<Wallet[]>`
  select w.handle, w.evm_address, w.sol_address
    from wallets w join trader_stats_current s using (handle)
   where (w.evm_address is not null or w.sol_address is not null)
   order by coalesce((select max(t.ingested_at) from transactions t
                       where t.address_key in (w.evm_address_key, w.sol_address_key)
                         and t.source <> 'helius-webhook'), 'epoch'::timestamptz) asc,
            s.rank nulls last`;

/** One multi-row upsert; `transfer_key` is generated in SQL so it cannot drift from the migration. */
async function upsert(sql: Sql, rows: readonly Row[]): Promise<void> {
  const values = rows.map((_, i) => {
    const b = i * 12;
    return `($${b+1},$${b+2},$${b+3},md5(coalesce($${b+7},'')||'|'||coalesce($${b+5},'')||'|'||coalesce($${b+6},'')||'|'||coalesce($${b+9}::text,'')),$${b+4}::timestamptz,$${b+5},$${b+6},$${b+7},$${b+8},$${b+9}::numeric,$${b+10},$${b+11},$${b+12})`;
  }).join(",");
  await sql.unsafe(
    `insert into transactions
       (network_id, tx_hash, address_key, transfer_key, block_time, direction,
        counterparty, token_key, token_symbol, amount, source, tx_type, tx_source)
     values ${values}
     on conflict (network_id, tx_hash, address_key, transfer_key) do update set
       block_time = excluded.block_time, token_symbol = excluded.token_symbol,
       amount = excluded.amount, source = excluded.source,
       tx_type = coalesce(excluded.tx_type, transactions.tx_type),
       tx_source = coalesce(excluded.tx_source, transactions.tx_source),
       ingested_at = now()`,
    rows.flat(),
  );
}

/** Fetch one wallet on every chain and upsert its rows. Returns rows written. */
async function backfillWallet(sql: Sql, keys: ProviderKeys, w: Wallet): Promise<number> {
  // includeNative pulls the native SOL side of a swap; without it a spend cannot be attributed.
  const out = await fetchTransactions(keys, w.evm_address, w.sol_address, null, LIMIT, { pages: PAGES, includeNative: true });
  for (const c of out.chains) if (c.error) console.error(`transfers: ${w.handle} ${c.chain}: ${c.error}`);
  const rows = dedupe(toRows(w, out.transfers));
  for (const part of chunk(rows, INSERT_CHUNK)) await upsert(sql, part);
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
    union select address from linked_wallets where watch and address is not null
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
  const sql = db(env);
  try {
    const targets = await selectTargets(sql);
    let wallets = 0, rowsUpserted = 0, errored = 0, stoppedEarly = false;
    for (let i = 0; i < targets.length; i += FANOUT) {
      if (Date.now() - started > budgetMs - SYNC_RESERVE_MS) { stoppedEarly = true; break; }
      const slice = targets.slice(i, i + FANOUT);
      const results = await Promise.allSettled(slice.map((w) => backfillWallet(sql, keys, w)));
      results.forEach((r, j) => {
        wallets += 1;
        if (r.status === "fulfilled") { rowsUpserted += r.value; return; }
        errored += 1;
        console.error(`transfers: ${slice[j].handle} failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      });
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
