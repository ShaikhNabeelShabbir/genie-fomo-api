import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { rpc, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import { bondingCurveAddress, decodeCurve, type Curve } from "../../../supabase/functions/_shared/pumpfun.ts";
import { accountData, fromBase64, rpcError, signatures } from "./launches-core";

/**
 * Nightly launch metadata and dev ledger, the Worker half of refresh.yml steps 6d
 * ("Refresh token launch metadata", "Refresh dev ledger").
 *
 * TWIN OF `scripts/load_token_launch.mjs` (phase 1) and `scripts/refresh_creators.mjs`
 * (phase 2): edit all three. Same target SQL, same curve read and creation-time paging, same
 * update; same two derived upserts in one transaction. Differs only where the platform does:
 * a wall-clock budget with a slice reserved for phase 2, a token whose creation-time paging
 * fails is counted rather than fatal, the creators statement_timeout is the remaining budget
 * rather than 0, and no `--dry-run`/`--limit`/`--token` flags.
 */

type Sql = postgres.Sql;
interface Target { readonly address: string; readonly token_key: string; readonly created_at: Date | null }
interface Launch extends Curve { readonly curve: string }

// ponytail: 20 pages = 20,000 signatures, the deepest curve history measured (31 s).
// Past it created_at stays null; raise, or move to a Helius-indexed read, if that shows up often.
const MAX_SIG_PAGES = 20;
/** Wall clock phase 1 leaves for the creators rebuild so a long token list cannot starve it every night. */
const CREATORS_RESERVE_MS = 60_000;

export interface LaunchesSummary {
  /** Tokens whose launch columns were written (pump.fun or not). */
  readonly launchesRefreshed: number;
  /** Tokens found with a pump.fun bonding curve. */
  readonly curvesRead: number;
  /** Rows upserted into `creators`; 0 when phase 2 did not run or failed. */
  readonly creatorsRefreshed: number;
  /** Tokens whose read failed, plus 1 when the creators rebuild failed. */
  readonly errored: number;
  /** Tokens never read because the budget ran out. Zero means phase 1 was complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

const TOKEN_CREATORS = `
  select network_id, token_key,
         lower(raw->'dev'->>'creator_address')            as creator_address_key,
         nullif(raw->'dev'->>'creator_token_status', '')   as creator_status
  from token_info
  where nullif(raw->'dev'->>'creator_address', '') is not null`;

const CREATORS = `
  with per_token as (
    select tc.network_id, tc.creator_address_key, tc.token_key, tc.creator_status,
           ti.is_honeypot, tk.first_seen_at,
           lower(nullif(ti.raw->'dev'->'ath_token_info'->>'ath_token', '')) as ath_token_key,
           nullif((ti.raw->'dev'->'ath_token_info'->>'ath_mc')::numeric, 0)  as ath_mc
    from token_creators tc
    join token_info ti using (network_id, token_key)
    join tokens tk using (network_id, token_key)
  ),
  best as (
    select distinct on (network_id, creator_address_key)
           network_id, creator_address_key, ath_token_key, ath_mc
    from per_token
    order by network_id, creator_address_key, ath_mc desc nulls last
  )
  select p.network_id, p.creator_address_key,
         count(distinct p.token_key)::int                                   as launches,
         b.ath_mc                                                           as best_peak_mcap_usd,
         b.ath_token_key                                                    as best_token_key,
         count(*) filter (where p.creator_status = 'creator_hold')::int      as still_holding_count,
         count(*) filter (where p.creator_status = 'creator_close')::int     as sold_count,
         count(*) filter (where p.is_honeypot)::int                          as honeypot_count,
         max(p.first_seen_at)                                                as last_launch_at
  from per_token p
  join best b using (network_id, creator_address_key)
  group by p.network_id, p.creator_address_key, b.ath_mc, b.ath_token_key`;

/** Held or recently traded Solana tokens, unread or ungraduated; stalest first. */
const targets = (sql: Sql) => sql<Target[]>`
  select tk.address, tk.token_key, tk.created_at
    from tokens tk
   where tk.network_id = ${SOLANA_NETWORK_ID}
     and (tk.launch_read_at is null or tk.graduated = false)
     and (exists (select 1 from holdings_current h where h.network_id = tk.network_id and h.token_key = tk.token_key)
       or exists (select 1 from transactions t where t.network_id = tk.network_id and t.token_key = tk.token_key
                     and t.block_time > now() - interval '30 days'))
   order by tk.launch_read_at nulls first, tk.address`;

async function readCurve(url: string, mint: string): Promise<Launch | null> {
  const curve = await bondingCurveAddress(mint);
  const j: unknown = await rpc(url, { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [curve, { encoding: "base64" }] });
  const err = rpcError(j);
  if (err !== null) throw new Error(err);
  const b64 = accountData(j);
  const decoded = b64 ? decodeCurve(fromBase64(b64)) : null;
  return decoded ? { curve, ...decoded } : null;
}

/** Block time of the oldest signature on the account, or null past MAX_SIG_PAGES. */
async function createdAt(url: string, account: string): Promise<Date | null> {
  let before: string | undefined;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const j: unknown = await rpc(url, { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [account, { limit: 1000, before }] });
    const sigs = signatures(j);
    if (!sigs.length) break;
    const oldest = sigs[sigs.length - 1];
    before = oldest.signature;
    if (sigs.length < 1000) return oldest.blockTime ? new Date(oldest.blockTime * 1000) : null;
  }
  return null;
}

/** Read one token's curve (and, the first time a curve is seen, its creation time) and write it. Returns whether it is a pump.fun token. */
async function refreshToken(sql: Sql, url: string, t: Target): Promise<boolean> {
  const launch = await readCurve(url, t.address);
  // Creation is immutable: read it once, the first time the curve is seen.
  const created = launch ? (t.created_at ?? await createdAt(url, launch.curve)) : null;
  await sql`
    update tokens
       set launchpad = ${launch ? "pump.fun" : null}, curve_progress = ${launch?.progress ?? null}, graduated = ${launch?.graduated ?? null},
           created_at = coalesce(created_at, ${created}), launch_read_at = now()
     where network_id = ${SOLANA_NETWORK_ID} and token_key = ${t.token_key}`;
  return launch !== null;
}

/** Two derived upserts in one transaction: token_creators, then creators. Returns the creators row count. */
async function refreshCreators(sql: Sql, timeoutMs: number): Promise<number> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`set local statement_timeout = '${Math.max(1, Math.floor(timeoutMs))}'`);
    await tx.unsafe(`
      insert into token_creators (network_id, token_key, creator_address_key, creator_status)
      ${TOKEN_CREATORS}
      on conflict (network_id, token_key) do update set
        creator_address_key = excluded.creator_address_key,
        creator_status      = excluded.creator_status`);
    const cr = await tx.unsafe(`
      insert into creators (network_id, creator_address_key, launches, best_peak_mcap_usd,
                            best_token_key, still_holding_count, sold_count, honeypot_count,
                            last_launch_at, updated_at)
      select *, now() from (${CREATORS}) s
      on conflict (network_id, creator_address_key) do update set
        launches            = excluded.launches,
        best_peak_mcap_usd  = excluded.best_peak_mcap_usd,
        best_token_key      = excluded.best_token_key,
        still_holding_count = excluded.still_holding_count,
        sold_count          = excluded.sold_count,
        honeypot_count      = excluded.honeypot_count,
        last_launch_at      = excluded.last_launch_at,
        updated_at          = now()`);
    return cr.count;
  });
}

/**
 * Phase 1 reads curves until `budgetMs - CREATORS_RESERVE_MS`; phase 2 rebuilds the dev ledger
 * in what is left. Throws only when nothing at all could be written, so the cron shows as failed.
 */
export async function runLaunches(env: Env, budgetMs: number): Promise<LaunchesSummary> {
  const started = Date.now();
  const helius = (env.HELIUS_SOLANA_KEY ?? "").trim();
  if (!helius) throw new Error("launches: HELIUS_SOLANA_KEY is not set; Solana is read through Helius only");
  const url = `https://mainnet.helius-rpc.com/?api-key=${helius}`;
  const sql = db(env);
  try {
    const list = await targets(sql);
    let launchesRefreshed = 0, curvesRead = 0, errored = 0, attempted = 0, stoppedEarly = false;
    for (const t of list) {
      if (Date.now() - started > budgetMs - CREATORS_RESERVE_MS) { stoppedEarly = true; break; }
      attempted += 1;
      try {
        if (await refreshToken(sql, url, t)) curvesRead += 1;
        launchesRefreshed += 1;
      } catch (e) {
        errored += 1;
        console.error(`launches: ${t.address} read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let creatorsRefreshed = 0, creatorsOk = false;
    if (Date.now() - started > budgetMs) {
      stoppedEarly = true;
    } else {
      try {
        creatorsRefreshed = await refreshCreators(sql, budgetMs - (Date.now() - started));
        creatorsOk = true;
      } catch (e) {
        errored += 1;
        console.error(`launches: creators rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (launchesRefreshed === 0 && !creatorsOk && (attempted > 0 || !stoppedEarly)) {
      throw new Error(`launches: nothing written (${errored} failure(s) over ${attempted} token(s) and the creators rebuild)`);
    }
    return { launchesRefreshed, curvesRead, creatorsRefreshed, errored, remaining: list.length - attempted, stoppedEarly, elapsedMs: Date.now() - started };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
