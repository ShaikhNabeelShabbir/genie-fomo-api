import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import {
  SOLANA_NETWORK_ID, SOURCE, canonical, chunk, holdingRows, isRecord, mergePositions, parseBalances,
  parseLeaderboard, parseOpenTrades, rejectBuild, statsRow, tokenRows, traderRow, walletRow,
  type Entry, type OpenTrade, type Position, type StatsRow, type TraderRow, type WalletRow,
} from "./directory-core";

/**
 * Directory refresh, the Worker half of refresh.yml steps 1 and 2:
 * `build_directory_fomoapi.py --top 100` then `load_to_db.py`, nightly.
 *
 * Same endpoints, same rows, same ON CONFLICT clauses. The python built a JSON file and loaded
 * it in one transaction; here the generation lands in two phases so a run cut short can RESUME:
 * the leaderboard (traders, wallets, trader_stats, builds) in one transaction first, then the
 * positions per chunk of FANOUT traders under the same `captured_at`. A build whose
 * `holding_count` is still null is in progress, and the next run continues it with the traders
 * that have no holdings row in that generation yet. Ingestion stays APPEND-ONLY: `captured_at`
 * is the primary key on holdings and trader_stats, so each run adds a generation.
 */

type Sql = postgres.Sql;
interface Target { readonly handle: string; readonly display_handle: string }
interface Generation { readonly captured: Date; readonly targets: readonly Target[] }
/** One trader's positions; `failed` is how many of its two fomo calls errored (its rows may be incomplete). */
interface Fetched { readonly positions: readonly Position[]; readonly failed: number }

const API = "https://api.fomoapi.io";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const WINDOW = "30d";
/** fomoapi caps at 100; `offset` is ignored, so 101-150 are unreachable. */
const TOP = 100;
const TRADE_LIMIT = 100;
/** `max_workers=6` in the python. */
const FANOUT = 6;
const TRIES = 3;
const FETCH_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 20_000;
/** fomoapi never returns a chain id, so it is recovered from the chain itself with eth_getCode. */
const EVM_CHAINS: readonly (readonly [number, string])[] = [
  [4663, "https://rpc.mainnet.chain.robinhood.com"],
  [1, "https://ethereum-rpc.publicnode.com"],
  [56, "https://bsc-dataseed.binance.org"],
  [8453, "https://mainnet.base.org"],
];

export interface DirectorySummary {
  /** Leaderboard traders fetched this run; 0 when the run resumed an unfinished generation. */
  readonly fetched: number;
  /** Trader rows upserted (with their stats). */
  readonly upserted: number;
  /** Traders flagged `listed = false` this run. */
  readonly delisted: number;
  /** Wallet rows upserted. */
  readonly wallets: number;
  /** Traders for which a fomo call failed; whatever came back was still written, as the python did. */
  readonly errored: number;
  /** Traders whose positions were not fetched because the budget ran out. Zero means the generation is complete. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A sleep the budget deadline can cut short. */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** `api_get` of the python: three tries, 429 waits for retry-after, 401/403 is final. Throws with the same messages. */
async function apiGet(path: string, key: string, signal: AbortSignal): Promise<unknown> {
  const headers = { authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": UA };
  for (let attempt = 0; attempt < TRIES; attempt++) {
    let r: Response;
    try {
      r = await fetch(`${API}${path}`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) });
    } catch (e) {
      if (attempt === TRIES - 1 || signal.aborted) throw new Error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      await sleep(1500 * (attempt + 1), signal);
      continue;
    }
    if (r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 5) * 1000, signal); continue; }
    if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} — key rejected`);
    if (!r.ok) {
      if (attempt === TRIES - 1) throw new Error(`HTTP ${r.status}`);
      await sleep(1500 * (attempt + 1), signal);
      continue;
    }
    try { return await r.json(); } catch { throw new Error("response was not JSON"); }
  }
  throw new Error("exhausted retries");
}

/** eth_getCode returns '0x' where nothing is deployed. The User-Agent matters: some of these RPCs reject a bare client with 403. */
async function hasCode(rpc: string, addr: string, signal: AbortSignal): Promise<boolean> {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [addr, "latest"] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]),
    });
    const body: unknown = await r.json();
    return (isRecord(body) && typeof body.result === "string" ? body.result : "0x").length > 2;
  } catch {
    return false;
  }
}

/**
 * A contract can exist at one address on several EVM chains, so every hit is returned and the
 * position is emitted once per chain: the resolver finds no holder on the wrong one and
 * self-corrects, which beats guessing. `cache` is keyed on the lowercased address.
 */
async function detectNetworks(addr: string, cache: Map<string, readonly number[]>, signal: AbortSignal): Promise<readonly number[]> {
  if (!addr.startsWith("0x")) return [SOLANA_NETWORK_ID];
  const key = addr.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const found = await Promise.all(EVM_CHAINS.map(([, rpc]) => hasCode(rpc, addr, signal)));
  const nets = EVM_CHAINS.filter((_, i) => found[i]).map(([id]) => id);
  cache.set(key, nets);
  return nets;
}

/**
 * Chains already known for a 0x address, from `tokens`. The python re-asked four RPCs per
 * address every night; a Worker invocation has a subrequest cap, so only unseen addresses are asked.
 */
async function knownNetworks(sql: Sql): Promise<Map<string, readonly number[]>> {
  const rows = await sql<{ token_key: string; network_ids: number[] }[]>`
    select token_key, array_agg(network_id)::int[] as network_ids
      from tokens where network_id <> ${SOLANA_NETWORK_ID} and token_key like '0x%'
     group by token_key`;
  return new Map(rows.map((r) => [r.token_key, r.network_ids]));
}

/** Current positions, the fingerprint the resolver verifies against: /trades (open, EVM + Solana) merged with /balances (Solana, live). */
async function fetchPositions(handle: string, key: string, cache: Map<string, readonly number[]>, signal: AbortSignal): Promise<Fetched> {
  let failed = 0;
  let trades: OpenTrade[] = [];
  try {
    trades = parseOpenTrades(await apiGet(`/v2/users/${encodeURIComponent(handle)}/trades?limit=${TRADE_LIMIT}`, key, signal));
  } catch (e) {
    failed += 1;
    console.error(`directory: ${handle}: trades unavailable (${msg(e)})`);
  }
  const placed: (OpenTrade & { readonly networks: readonly number[] })[] = [];
  for (const t of trades) placed.push({ ...t, networks: await detectNetworks(t.address, cache, signal) });
  let balances: Position[] = [];
  try {
    balances = parseBalances(await apiGet(`/v2/users/${encodeURIComponent(handle)}/balances`, key, signal));
  } catch (e) {
    failed += 1;
    console.error(`directory: ${handle}: balances unavailable (${msg(e)})`);
  }
  return { positions: mergePositions(placed, balances), failed };
}

/** The generation still in progress, with the traders whose positions it lacks (rank order), or null. */
async function openGeneration(sql: Sql): Promise<Generation | null> {
  const [b] = await sql<{ captured_at: Date }[]>`
    select captured_at from builds where source = ${SOURCE} and holding_count is null order by captured_at desc limit 1`;
  if (!b) return null;
  const captured = new Date(b.captured_at);
  const targets = await sql<{ handle: string; display_handle: string }[]>`
    select s.handle, t.display_handle
      from trader_stats s join traders t using (handle)
     where s.captured_at = ${captured}
       and not exists (select 1 from holdings h where h.handle = s.handle and h.captured_at = s.captured_at and h.source = 'fomo')
     order by s.rank nulls last, s.handle`;
  return { captured, targets };
}

/** Phase 1, one transaction: the build row, then every FK target before its dependants, then the listed flag. */
async function writeLeaderboard(sql: Sql, captured: Date, entries: readonly Entry[]): Promise<{ targets: Target[]; wallets: number; delisted: number }> {
  /* One statement per table, so a handle repeated on the board must collapse first (the python's executemany let the later row win). */
  const byHandle = new Map(entries.map((e) => [canonical(e.handle), e]));
  const traders: TraderRow[] = [], stats: StatsRow[] = [], wallets: WalletRow[] = [];
  for (const e of byHandle.values()) {
    traders.push(traderRow(e));
    stats.push(statsRow(e, captured));
    const w = walletRow(e);
    if (w) wallets.push(w);
  }
  const handles = traders.map((t) => t.handle);
  const delisted = await sql.begin(async (tx) => {
    /* The build row first: it records what the row tables cannot, notably the leaderboard `window`. holding_count lands when the generation completes. */
    await tx`
      insert into builds (captured_at, window_label, source, trader_count, holding_count)
      values (${captured}, ${WINDOW}, ${SOURCE}, ${traders.length}, null)
      on conflict (captured_at) do update set
        window_label = excluded.window_label, source = excluded.source,
        trader_count = excluded.trader_count, holding_count = excluded.holding_count`;
    await tx`
      insert into traders ${tx(traders, "handle", "display_handle", "name", "avatar", "bio", "twitter", "verified", "source")}
      on conflict (handle) do update set
        display_handle = excluded.display_handle,
        name = excluded.name, avatar = excluded.avatar, bio = excluded.bio,
        twitter = excluded.twitter, verified = excluded.verified,
        last_seen_at = now()`;
    /* An address only ever moves forward: coalesce keeps a previously known address if a later build omits it, rather than blanking the row. */
    if (wallets.length) {
      await tx`
        insert into wallets ${tx(wallets, "handle", "evm_address", "evm_source", "sol_address", "sol_source")}
        on conflict (handle) do update set
          evm_address = coalesce(excluded.evm_address, wallets.evm_address),
          evm_source  = coalesce(excluded.evm_source,  wallets.evm_source),
          sol_address = coalesce(excluded.sol_address, wallets.sol_address),
          sol_source  = coalesce(excluded.sol_source,  wallets.sol_source),
          last_seen_at = now()`;
    }
    await tx`
      insert into trader_stats ${tx(stats, "handle", "captured_at", "rank", "pnl_usd", "volume_usd", "trade_count", "followers")}
      on conflict (handle, captured_at) do update set
        rank = excluded.rank, pnl_usd = excluded.pnl_usd, volume_usd = excluded.volume_usd,
        trade_count = excluded.trade_count, followers = excluded.followers`;
    /* Migration 20260916140000: A FLAG, NOT A DELETE. A fomoapi trader the board no longer carries AND who has no address is
       "listed and unpriceable"; one with a wallet still has chain reads and stays. Reversed the moment the source lists them again. */
    const gone = await tx`
      update traders set listed = false, delisted_at = now(), delisted_reason = 'absent_from_source'
       where source = ${SOURCE} and listed and handle <> all(${handles}::text[])
         and not exists (select 1 from wallets w where w.handle = traders.handle)`;
    await tx`
      update traders set listed = true, delisted_at = null, delisted_reason = null
       where not listed and handle = any(${handles}::text[])`;
    return gone.count;
  });
  return { targets: traders.map((t) => ({ handle: t.handle, display_handle: t.display_handle })), wallets: wallets.length, delisted };
}

/** Phase 2, per chunk: tokens before holdings (FK). Returns holdings rows written. */
async function writePositions(sql: Sql, captured: Date, group: readonly Target[], fetched: readonly Fetched[]): Promise<number> {
  const tokens = tokenRows(fetched.flatMap((f) => f.positions));
  const holdings = group.flatMap((t, i) => holdingRows(t.handle, captured, fetched[i].positions));
  if (!holdings.length) return 0;
  await sql.begin(async (tx) => {
    await tx`
      insert into tokens ${tx(tokens, "network_id", "address")}
      on conflict (network_id, token_key) do update set last_seen_at = now()`;
    await tx`
      insert into holdings ${tx(holdings, "handle", "network_id", "token_key", "captured_at", "human_amount", "price", "value")}
      on conflict (handle, network_id, token_key, captured_at) do update set
        human_amount = excluded.human_amount, price = excluded.price, value = excluded.value`;
  });
  return holdings.length;
}

/**
 * One pass within `budgetMs`: finish the open generation if there is one, else fetch the
 * leaderboard and start a new one. Throws when the leaderboard cannot be fetched or fails the
 * build checks (the python's `die`), or when nothing at all could be written.
 */
export async function runDirectory(env: Env, budgetMs: number): Promise<DirectorySummary> {
  const key = (env.FOMOAPI_KEY ?? "").trim();
  if (!key) throw new Error("FOMOAPI_KEY is not set; refusing to run the directory refresh");
  const started = Date.now();
  const deadline = AbortSignal.timeout(budgetMs);
  const sql = db(env);
  const s = { fetched: 0, upserted: 0, delisted: 0, wallets: 0, errored: 0, remaining: 0, stoppedEarly: false, elapsedMs: 0 };
  try {
    let gen = await openGeneration(sql);
    if (!gen) {
      let body: unknown;
      try {
        body = await apiGet(`/v2/leaderboard/${WINDOW}?limit=${TOP}`, key, deadline);
      } catch (e) {
        throw new Error(`directory: leaderboard fetch failed: ${msg(e)}`);
      }
      const entries = parseLeaderboard(body, TOP);
      const [prev] = await sql<{ trader_count: number | null }[]>`select trader_count from builds order by captured_at desc limit 1`;
      const prevCount = prev?.trader_count ?? null;
      const why = rejectBuild(entries, prevCount === null ? null : Number(prevCount));
      if (why) throw new Error(`directory: ${why}`);
      /* `generated_at` was `int(time.time())`: whole seconds. */
      const captured = new Date(Math.floor(started / 1000) * 1000);
      const w = await writeLeaderboard(sql, captured, entries);
      s.fetched = entries.length; s.upserted = w.targets.length; s.wallets = w.wallets; s.delisted = w.delisted;
      gen = { captured, targets: w.targets };
    }
    const cache = await knownNetworks(sql);
    let done = 0, written = 0;
    for (const group of chunk(gen.targets, FANOUT)) {
      if (deadline.aborted) { s.stoppedEarly = true; break; }
      const fetched = await Promise.all(group.map((t) => fetchPositions(t.display_handle, key, cache, deadline)));
      /* A chunk the deadline cut into is not written: its traders are refetched when the generation resumes. */
      if (deadline.aborted) { s.stoppedEarly = true; break; }
      s.errored += fetched.filter((f) => f.failed > 0).length;
      try {
        written += await writePositions(sql, gen.captured, group, fetched);
      } catch (e) {
        s.errored += group.length;
        console.error(`directory: writing ${group.length} traders' positions failed: ${msg(e)}`);
      }
      done += group.length;
    }
    s.remaining = gen.targets.length - done;
    if (done > 0 && written === 0 && s.errored >= done && s.upserted === 0) {
      throw new Error(`directory: none of ${done} traders' positions could be written — fomoapi is not answering`);
    }
    if (s.remaining === 0) {
      await sql`
        update builds set holding_count = (select count(*) from holdings where captured_at = ${gen.captured} and source = 'fomo')
         where captured_at = ${gen.captured}`;
    }
    s.elapsedMs = Date.now() - started;
    return s;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
