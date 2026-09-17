import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import type { Load } from "./scorecards-core";
import { chunk } from "./directory-core";
import {
  CHAINS, EVM_CHAINS, type DiscoveredWallet, type Position, fold, group, newTraders, walletFrom,
} from "./gmgn-core";

/**
 * GMGN directory source, the Worker half of `scripts/load_gmgn_traders.mjs` (phase 1: KOL
 * and smart-money wallets become `traders` + `wallets` rows, `source = 'gmgn'`) and
 * `scripts/load_gmgn_trades.mjs --stale-hours` (phase 2: their `wallet_activity` folded into
 * per-token `trades` rows, then a `trader_stats` row). Same SQL; differs only where the
 * platform does — a wall-clock budget, stalest first, a failed trader counted not fatal, and
 * one `trade_loads` row per attempt so a trader with no activity still converges (the
 * script's selector reads `trades.ingested_at`, which an empty fetch never moves).
 */

interface Target { readonly handle: string; readonly sol_address: string | null; readonly evm_address: string | null }

const API = "https://openapi.gmgn.ai";
const ROUNDS = 4;
const PAGES = 12;
const STALE_HOURS = 72;
/** kol/smartmoney are weight 1 on a rate-20 bucket; wallet_activity weight 3 (~6.7 req/s). */
const LIST_GAP_MS = 900;
const ACTIVITY_GAP_MS = 320;
const FETCH_TIMEOUT_MS = 30_000;
const TRIES = 4;
/** Rows per multi-row insert: the widest is `trades` at 14 columns, so 6 x 14 = 84 bound values (D1 allows 100). */
const WRITE_CHUNK = 6;
/** `-72 hours` as a SQLite date modifier. */
const STALE_AGO = `-${STALE_HOURS} hours`;

export interface GmgnSummary {
  /** Distinct people the two GMGN lists returned this run. */
  readonly traders: number;
  /** New `traders` rows inserted. */
  readonly tradersUpserted: number;
  /** Stale gmgn traders selected for a trades refresh. */
  readonly tradesTargeted: number;
  /** `trades` rows upserted. */
  readonly tradesUpserted: number;
  /** Traders whose every fetch failed, or whose write failed. They stay selected. */
  readonly errored: number;
  /** Traders still stale when the run ended. Zero means converged. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 60);

class RateLimited extends Error {
  constructor(readonly wait: number) { super("RATE_LIMIT"); }
}

/** One GMGN call with the script's retry: rate limits back off 6 s per attempt (retrying inside the cooldown extends the ban). */
async function gmgn(path: string, key: string, extra: Record<string, string>): Promise<unknown> {
  for (let i = 1; ; i++) {
    try {
      const qs = new URLSearchParams({ timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID(), ...extra });
      const r = await fetch(`${API}${path}?${qs}`, { headers: { "X-APIKEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const j: unknown = await r.json().catch(() => null);
      const body = isRecord(j) ? j : {};
      if (r.status === 429 || (typeof body.error === "string" && body.error.startsWith("RATE_LIMIT"))) throw new RateLimited(6000 * i);
      if (body.code !== 0) throw new Error(String(body.msg ?? body.message ?? `code ${body.code}`).slice(0, 60));
      return body.data;
    } catch (e) {
      if (i >= TRIES) throw e;
      await sleep(e instanceof RateLimited ? e.wait : LIST_GAP_MS * i);
    }
  }
}

/** Every chain, both lists, ROUNDS polls each (the feed is a stream). A failed list is logged and skipped. */
async function discover(key: string, outOfTime: () => boolean): Promise<DiscoveredWallet[]> {
  const found = new Map<string, DiscoveredWallet>();
  for (const chain of Object.keys(CHAINS)) {
    for (const ep of ["/v1/user/kol", "/v1/user/smartmoney"]) {
      for (let i = 0; i < ROUNDS && !outOfTime(); i++) {
        let d: unknown;
        try { d = await gmgn(ep, key, { chain, limit: "100" }); } catch (e) { console.error(`gmgn: ${chain}${ep} failed: ${message(e)}`); break; }
        const list = isRecord(d) && Array.isArray(d.list) ? d.list : [];
        for (const x of list) {
          const w = walletFrom(x, chain);
          if (w && !found.has(`${chain}|${w.wallet}`)) found.set(`${chain}|${w.wallet}`, w);
        }
        await sleep(LIST_GAP_MS);
      }
    }
  }
  return [...found.values()];
}

/** Phase 1: the script's insert into traders, then the wallets that reference them. Returns rows inserted. */
async function loadTraders(sql: Sql, key: string, outOfTime: () => boolean): Promise<{ people: number; inserted: number }> {
  const people = group(await discover(key, outOfTime));
  const existing = new Set((await sql<{ handle: string }[]>`select handle from traders`).map((r) => r.handle));
  const rows = newTraders(people, existing);
  if (!rows.length) return { people: people.length, inserted: 0 };
  // SQLite has no unnest: explicit `values` rows, chunked to stay inside D1's 100 parameters.
  // `traders.id` has no default here, so the Worker mints it.
  const inserted = await sql.begin(async (tx) => {
    let n = 0;
    for (const part of chunk(rows, WRITE_CHUNK)) {
      n += (await tx.unsafe(
        `insert into traders (handle, display_handle, name, avatar, bio, twitter, id, source)
         values ${part.map(() => "(?,?,?,?,?,?,?,'gmgn')").join(",")}
         on conflict (handle) do nothing`,
        part.flatMap((t) => [t.handle, t.display_handle, t.name, t.avatar, t.bio, t.twitter, crypto.randomUUID()]),
      )).count;
    }
    // Wallets after the traders they reference: each await above flushed its batch.
    for (const part of chunk(rows, WRITE_CHUNK)) {
      await tx.unsafe(
        `insert into wallets (handle, sol_address, sol_source, evm_address, evm_source)
         values ${part.map(() => "(?,?,?,?,?)").join(",")}
         on conflict (handle) do nothing`,
        part.flatMap((t) => [t.handle, t.sol, t.sol !== null ? "gmgn" : null, t.evm, t.evm !== null ? "gmgn" : null]),
      );
    }
    return n;
  });
  return { people: people.length, inserted };
}

/**
 * Who to refresh: gmgn traders whose newest trade row, or newest `loaded` attempt, is older
 * than STALE_HOURS, stalest first. SELF-CONVERGING: an attempted trader drops out.
 */
const selectTargets = (sql: Sql) => sql<Target[]>`
  select handle, sol_address, evm_address from (
    select t.handle, w.sol_address, w.evm_address,
           -- SQLite's scalar max() answers NULL if any argument is, so '' stands in for the
           -- 'epoch' sentinel: it sorts and compares below every ISO timestamp, as epoch did.
           max(coalesce((select max(tr.ingested_at) from trades tr where tr.handle = t.handle), ''),
               coalesce((select max(l.attempted_at) from trade_loads l
                          where l.handle = t.handle and l.outcome = 'loaded'), '')) as fresh
      from traders t join wallets w on w.handle = t.handle
     where t.source = 'gmgn') s
   where fresh < strftime('%Y-%m-%dT%H:%M:%fZ','now',${STALE_AGO})
   order by fresh, handle`;

/** One wallet's activity on one chain, up to PAGES pages. Throws when the first page fails. */
async function activity(key: string, chain: string, wallet: string, outOfTime: () => boolean): Promise<unknown[]> {
  const acts: unknown[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < PAGES && !outOfTime(); p++) {
    const d = await gmgn("/v1/user/wallet_activity", key, { chain, wallet_address: wallet, limit: "100", ...(cursor ? { cursor } : {}) });
    const page = isRecord(d) && Array.isArray(d.activities) ? d.activities : [];
    acts.push(...page);
    cursor = isRecord(d) && typeof d.next === "string" && d.next !== "" ? d.next : null;
    if (!cursor || !page.length) break;
    await sleep(ACTIVITY_GAP_MS);
  }
  return acts;
}

/** All of one trader's positions across their chains. `fetched` counts chain jobs that answered. */
async function positions(key: string, t: Target, outOfTime: () => boolean): Promise<{ rows: Position[]; fetched: number; failed: number; lastError: string | null }> {
  const jobs: [string, string][] = [];
  if (t.sol_address) jobs.push(["sol", t.sol_address]);
  if (t.evm_address) for (const ch of EVM_CHAINS) jobs.push([ch, t.evm_address]);
  const rows: Position[] = [];
  let fetched = 0, failed = 0, lastError: string | null = null;
  for (const [chain, wallet] of jobs) {
    try {
      const acts = await activity(key, chain, wallet, outOfTime);
      fetched++;
      if (acts.length) rows.push(...fold(acts, CHAINS[chain]));
    } catch (e) {
      // The script breaks out of the page loop and keeps what it has; a failed first page is an empty chain.
      failed++; lastError = message(e);
    }
    await sleep(ACTIVITY_GAP_MS);
  }
  return { rows, fetched, failed, lastError };
}

/** The script's tokens-then-trades write; D1 batches each chunk, so a chunk lands whole or not at all. */
async function writeTrades(sql: Sql, handle: string, rows: readonly Position[], capturedAt: Date): Promise<void> {
  const at = capturedAt.toISOString();
  await sql.begin(async (tx) => {
    // tokens first: `holdings` has an FK to it and the scorecard reads total_supply from it.
    // token_key is a plain column in D1, so the lowered address is written explicitly.
    for (const part of chunk(rows, WRITE_CHUNK)) {
      await tx.unsafe(
        `insert into tokens (network_id, address, token_key, symbol, total_supply, supply_source, supply_read_at)
         values ${part.map(() => "(?,?,?,?,?,?,?)").join(",")}
         on conflict (network_id, token_key) do update
           set total_supply = coalesce(tokens.total_supply, excluded.total_supply),
               supply_source = coalesce(tokens.supply_source, excluded.supply_source),
               supply_read_at = coalesce(tokens.supply_read_at, excluded.supply_read_at),
               symbol = coalesce(tokens.symbol, excluded.symbol)`,
        part.flatMap((r) => [
          r.network_id, r.token_address, r.token_key, r.token_symbol, r.total_supply,
          r.total_supply !== null ? "gmgn_activity" : null, r.total_supply !== null ? at : null,
        ]),
      );
    }
    for (const part of chunk(rows, WRITE_CHUNK)) {
      await tx.unsafe(
        `insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol,
                             status, amount, avg_entry_price, avg_exit_price, realized_pnl_usd,
                             opened_at, closed_at, captured_at)
         values ${part.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(",")}
         on conflict (trade_id) do update set
           status = excluded.status, amount = excluded.amount,
           avg_entry_price = excluded.avg_entry_price, avg_exit_price = excluded.avg_exit_price,
           realized_pnl_usd = excluded.realized_pnl_usd, opened_at = excluded.opened_at,
           closed_at = excluded.closed_at, captured_at = excluded.captured_at`,
        part.flatMap((r) => [
          `gmgn:${handle}:${r.network_id}:${r.token_key}`, handle, r.network_id, r.token_address,
          r.token_key, r.token_symbol, r.status, r.amount, r.avg_entry_price, r.avg_exit_price,
          r.realized_pnl_usd, r.opened_at, r.closed_at, at,
        ]),
      );
    }
  });
}

/** The script's stats row so the board can rank them; rank and followers stay NULL (fomo-leaderboard concepts). */
const writeStats = (sql: Sql, capturedAt: Date) => sql`
  insert into trader_stats (handle, captured_at, pnl_usd, volume_usd, trade_count)
  select tr.handle, ${capturedAt},
         sum(tr.realized_pnl_usd),
         sum(coalesce(tr.amount * tr.avg_entry_price, 0)),
         count(*)
  from trades tr join traders t on t.handle = tr.handle
  where t.source = 'gmgn'
  group by tr.handle
  on conflict (handle, captured_at) do update
    set pnl_usd = excluded.pnl_usd, volume_usd = excluded.volume_usd,
        trade_count = excluded.trade_count`;

const recordLoad = (sql: Sql, handle: string, load: Load) =>
  sql`insert into trade_loads (handle, outcome, detail) values (${handle}, ${load.outcome}, ${load.detail})`;

/**
 * One pass within `budgetMs`: discover, then refresh the stalest traders. Throws only when
 * nothing at all could be done, so the cron shows a failed invocation.
 */
export async function runGmgn(env: Env, budgetMs: number): Promise<GmgnSummary> {
  const key = (env.GMGN_API_KEY ?? "").trim();
  if (!key) throw new Error("GMGN_API_KEY is not set; refusing to run the GMGN load");
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budgetMs;
  const sql = jobSql(env);
  try {
    const phase1 = await loadTraders(sql, key, outOfTime);
    const targets = await selectTargets(sql);
    const capturedAt = new Date();
    let attempted = 0, errored = 0, tradesUpserted = 0, stoppedEarly = false;
    for (const t of targets) {
      if (outOfTime()) { stoppedEarly = true; break; }
      const p = await positions(key, t, outOfTime);
      // A fetch the budget cut short is partial: abandon it unwritten rather than fold half a history.
      if (outOfTime()) { stoppedEarly = true; break; }
      attempted++;
      if (p.fetched === 0) {
        errored++;
        await recordLoad(sql, t.handle, { outcome: "error", detail: p.lastError });
        continue;
      }
      try {
        if (p.rows.length) await writeTrades(sql, t.handle, p.rows, capturedAt);
        tradesUpserted += p.rows.length;
        await recordLoad(sql, t.handle, { outcome: "loaded", detail: `${p.rows.length} positions` });
      } catch (e) {
        // One trader's bad row must not cost the rest; it stays selected for the next run.
        errored++;
        console.error(`gmgn: ${t.handle} write failed: ${message(e)}`);
        await recordLoad(sql, t.handle, { outcome: "error", detail: message(e) });
      }
    }
    if (tradesUpserted > 0) await writeStats(sql, capturedAt);
    if (phase1.inserted === 0 && attempted > 0 && errored === attempted) {
      throw new Error(`gmgn: all ${attempted} trader(s) failed and nothing was discovered`);
    }
    return {
      traders: phase1.people,
      tradersUpserted: phase1.inserted,
      tradesTargeted: targets.length,
      tradesUpserted,
      errored,
      remaining: (await selectTargets(sql)).length,
      stoppedEarly,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
