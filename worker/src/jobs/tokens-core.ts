/**
 * Pure half of the token refresh (`./tokens.ts`): address shapes, Bitquery reply decoding, the
 * GMGN envelope and the token_info row, ported from `scripts/resolve_trade_chains.mjs`,
 * `scripts/load_token_supply.mjs` and `scripts/load_token_info.mjs` (the scripts still read
 * chains and supply over JSON-RPC; the Worker reads them from Bitquery). No I/O, so
 * `tests/tokens_test.ts` runs it under Deno.
 */
import type { Sql } from "../d1.ts";
import { REFUSALS_IN_A_ROW } from "../../../supabase/functions/_shared/settings.ts";
import { currentHoldings } from "../../../supabase/functions/_shared/current_holdings.ts";

export type Rec = Readonly<Record<string, unknown>>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------ chain shape
export const isEvmAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);
export const isSolAddress = (a: string): boolean => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

/** A 0x address seen on exactly one chain. Several is left unresolved: the same address really can be deployed twice. */
export const singleChain = (hits: readonly number[]): number | null => (hits.length === 1 ? hits[0] : null);

/** Rows of one cube under one root alias of a Bitquery reply (`data.<alias>.<cube>`). */
const cubeRows = (data: unknown, alias: string, cube: string): unknown[] => {
  const root = isRec(data) ? data[alias] : null;
  const rows = isRec(root) ? root[cube] : null;
  return Array.isArray(rows) ? rows : [];
};

/**
 * Chain probe reply: one `EVM` root per chain, aliased `n<id>`, each with a one-row Transfers
 * cube. A chain whose cube has a row has seen the contract.
 */
export const chainHits = (data: unknown, ids: readonly number[]): number[] =>
  ids.filter((id) => cubeRows(data, `n${id}`, "Transfers").length > 0);

// ---------------------------------------------------------------------- supply
/** `decimals` is what Bitquery said, null when it did not; `supply` is already in human units. */
export interface Supply { readonly supply: number; readonly decimals: number | null; readonly source: string }

function supplyOf(row: unknown, amountKey: "TotalSupply" | "PostBalance"): Supply | null {
  if (!isRec(row)) return null;
  const supply = num(row[amountKey]);
  if (supply === null || supply <= 0) return null;
  return { supply, decimals: isRec(row.Currency) ? num(row.Currency.Decimals) : null, source: "bitquery" };
}

/** `EVM.TransactionBalances[0].TokenBalance` (`TotalSupply`, `Currency.Decimals`). */
export const evmSupply = (data: unknown): Supply | null => {
  const [row] = cubeRows(data, "EVM", "TransactionBalances");
  return supplyOf(isRec(row) ? row.TokenBalance : null, "TotalSupply");
};

/** `Solana.TokenSupplyUpdates[0].TokenSupplyUpdate` (`PostBalance`, `Currency.Decimals`). */
export const solanaSupply = (data: unknown): Supply | null => {
  const [row] = cubeRows(data, "Solana", "TokenSupplyUpdates");
  return supplyOf(isRec(row) ? row.TokenSupplyUpdate : null, "PostBalance");
};

// ------------------------------------------------------------------------ gmgn
/** Our chain names are not GMGN's. Two differ and the rest pass through. */
export const CHAIN_CODE: Readonly<Record<string, string>> = { solana: "sol", ethereum: "eth", bsc: "bsc", base: "base", robinhood: "robinhood" };

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Postgres jsonb cannot hold a NUL (U+0000), and memecoin names are full of them. */
export const jsonForPg = (v: unknown): string => JSON.stringify(v).replace(/\\u0000/g, "");
/** Same problem in the plain text columns. */
export const clean = (v: unknown): string | null =>
  typeof v === "string" ? v.replace(/\u0000/g, "").replace(/\\u0000/g, "") : null;

/** Unwrap a GMGN envelope; throws "RATE_LIMIT" for their limiter so the caller backs off. */
export function gmgnData(ok: boolean, status: number, body: unknown): Rec {
  const j = isRec(body) ? body : null;
  if (j?.error === "RATE_LIMIT_EXCEEDED") throw new Error("RATE_LIMIT");
  if (!ok) throw new Error(`HTTP ${status}`);
  if (j?.code !== 0) throw new Error(String(j?.message ?? j?.error ?? "gmgn error").slice(0, 80));
  if (!isRec(j.data)) throw new Error("malformed document");
  return j.data;
}

/**
 * Why a GMGN read produced no document. `refused`: the SOURCE is turning us away (bad key, rate
 * limit, outage) and the next coin will fare no better. `nothing`: it answered, and has no document
 * for THIS coin — which is an answer, and the coin is parked instead of being asked first every run.
 */
export const gmgnFailure = (message: string): "refused" | "nothing" =>
  /^HTTP (?:401|403|429|5\d\d)$|RATE_LIMIT|timed? ?out|network|fetch failed|abort/i.test(message) ? "refused" : "nothing";

export interface Security {
  readonly is_honeypot: boolean | null;
  readonly is_open_source: boolean | null;
  readonly is_renounced: boolean | null;
  readonly renounced_mint: boolean | null;
  readonly renounced_freeze: boolean | null;
  readonly is_blacklisted: boolean | null;
  readonly can_not_sell: boolean | null;
  readonly buy_tax: number | null;
  readonly sell_tax: number | null;
  readonly rug_ratio: number | null;
  readonly burn_ratio: number | null;
}

/**
 * GMGN answers every field on every chain and the inapplicable ones come back `false`.
 * Inapplicable checks are stored NULL: "we do not know", never "safe". See load_token_info.mjs.
 */
export function normaliseSecurity(chain: string, d: Rec): Security {
  const sol = chain === "solana";
  const bool = (v: unknown): boolean | null => (v === null || v === undefined || v === "" ? null : Boolean(v));
  const cns = num(d.can_not_sell);
  return {
    is_honeypot: sol ? null : bool(d.is_honeypot),
    is_open_source: sol ? null : bool(d.is_open_source),
    is_renounced: sol ? null : bool(d.is_renounced),
    renounced_mint: sol ? bool(d.renounced_mint) : null,
    renounced_freeze: sol ? bool(d.renounced_freeze_account) : null,
    is_blacklisted: sol ? null : bool(d.is_blacklist),
    // can_not_sell is a count in their payload, not a flag.
    can_not_sell: cns === null ? null : cns > 0,
    buy_tax: num(d.buy_tax),
    sell_tax: num(d.sell_tax),
    rug_ratio: num(d.rug_ratio),
    burn_ratio: num(d.burn_ratio),
  };
}

/** Always ours (GMGN returned market_cap on 0 of 1,095 tokens); NULL above $10T, where it is a supply artifact. */
export function marketCap(reported: number | null, price: number | null, circ: number | null): number | null {
  const raw = reported ?? (price !== null && circ !== null ? price * circ : null);
  return raw !== null && raw <= 1e13 ? raw : null;
}

export interface InfoRow {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly price_usd: number | null;
  readonly liquidity_usd: number | null;
  readonly market_cap_usd: number | null;
  readonly total_supply: number | null;
  readonly circulating_supply: number | null;
  readonly max_supply: number | null;
  readonly holder_count: number | null;
  readonly top_10_holder_rate: number | null;
  /** GMGN's `logo`; null when absent or not a URL. */
  readonly logo_url: string | null;
  readonly raw: string;
}

/** A string that is a URL, else null: a logo field holding "" or a bare filename is no logo. */
export const urlOrNull = (v: unknown): string | null => {
  const s = clean(v);
  return s !== null && /^https?:\/\//.test(s) ? s : null;
};

/** The fundamentals columns from a /v1/token/info document. */
export function infoRow(d: Rec): InfoRow {
  const price = num(isRec(d.price) ? d.price.price : null);
  const circ = num(d.circulating_supply);
  return {
    symbol: clean(d.symbol),
    name: clean(d.name),
    price_usd: price,
    liquidity_usd: num(d.liquidity),
    market_cap_usd: marketCap(num(d.market_cap), price, circ),
    total_supply: num(d.total_supply),
    circulating_supply: circ,
    max_supply: num(d.max_supply),
    holder_count: num(d.holder_count),
    top_10_holder_rate: num(isRec(d.stat) ? d.stat.top_10_holder_rate : null),
    logo_url: urlOrNull(d.logo),
    raw: jsonForPg(d),
  };
}

export interface SupplyTarget { readonly network_id: number; readonly address: string; readonly token_key: string }

/**
 * Tokens where a supply would actually be used: an entry price exists, or somebody holds it. The
 * most valuable held position first (gross amount x price, ceilings or not): a supply is what lets
 * /positions run the implied-cap check on exactly those rows (V1b). Every current holding is read
 * ONCE, grouped, and joined: the Postgres lateral re-read it per token, which D1 running one
 * statement at a time cannot afford. "hv.token_key is not null" is the old "exists" over the same rows.
 */
export const supplyTargets = (sql: Sql, limit: number) => sql<SupplyTarget[]>`
  select tk.network_id, tk.address, tk.token_key
  from tokens tk
  left join (select network_id, token_key, max(human_amount * price) as held
               from ${currentHoldings(sql)} h group by network_id, token_key) hv
    on hv.network_id = tk.network_id and hv.token_key = tk.token_key
  where tk.total_supply is null
    and (hv.token_key is not null
         or exists (select 1 from trades t
                    where t.network_id = tk.network_id and t.token_key = tk.token_key
                      and t.avg_entry_price > 0))
  order by hv.held desc, tk.network_id, tk.address
  limit ${limit}`;

export interface InfoTarget { readonly network_id: number; readonly token_key: string; readonly address: string; readonly chain: string }

/**
 * The GMGN queue, in the order it is worked. Here, not in tokens.ts, so tests/tokens_queue_test.ts
 * can run it against the schema. `staleAgo` and `missRetryAgo` are SQLite date modifiers.
 */
export const infoTargets = (sql: Sql, staleAgo: string, missRetryAgo: string) => sql<InfoTarget[]>`
  select network_id, token_key, address, chain from (
    select due.*,
           row_number() over (order by holders desc, waited, token_key) as by_held,
           row_number() over (order by waited, holders desc, token_key) as by_wait
      from (
    select h.network_id, h.token_key, tk.address, ch.name as chain,
           count(distinct h.handle) as holders,
           max(coalesce(ti.fetched_at, ''), coalesce(ms.missed_at, '')) as waited
      from ${currentHoldings(sql)} h
      -- The cross joins state the order, h then tokens then chains: left free, the small derived table is drained into an automatic index.
      cross join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
      cross join chains ch on ch.network_id = h.network_id
      left join quote_assets q
        on q.network_id = h.network_id and q.token_key = h.token_key
      left join token_info ti
        on ti.network_id = h.network_id and ti.token_key = h.token_key
      left join token_info_misses ms
        on ms.network_id = h.network_id and ms.token_key = h.token_key
     where q.token_key is null
       -- Either half being stale is reason to refetch: security has its own timestamp.
       and (ti.fetched_at is null or ti.security_fetched_at is null
            or ti.fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${staleAgo})
            or ti.security_fetched_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${staleAgo}))
       -- A coin GMGN had nothing for waits before it is asked again. It used to be asked FIRST on
       -- every run (never-fetched sorted first and a miss left no trace), so the head of the queue
       -- was permanently coins GMGN does not know and the coins it does know sat 9 days old.
       and (ms.missed_at is null or ms.missed_at < strftime('%Y-%m-%dT%H:%M:%fZ','now',${missRetryAgo}))
     group by h.network_id, h.token_key, tk.address, ch.name, ti.fetched_at, ms.missed_at
      ) due)
   -- TWO ORDERS, INTERLEAVED: odd places to the most-held due coin, even places to the one longest since
   -- it was last ASKED (the LATER of answered and missed; never asked sorts before any date). A run reads ~94
   -- coins and the top ~1,030 by holders fall due again every 22 h, so most-held-first alone never reached the tail.
   order by min(2 * by_held - 1, 2 * by_wait)`;

// --------------------------------------------------------------- GMGN: the read loop and where a read goes
/*
 * Not pure, and here on purpose (19 Sep 2026): GMGN answers 429 to a Worker before its key is
 * checked, because its limit is per IP and a Worker shares its outgoing IPs. So the SAME loop has
 * to run somewhere else too (scripts/gmgn_reader.ts), and this is the module both can import.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALE_HOURS = 20;
/** The queue's staleness and a miss's wait, as SQLite date modifiers. */
export const GMGN_STALE_AGO = `-${STALE_HOURS} hours`;
export const GMGN_MISS_RETRY_AGO = "-7 days";
/** GMGN: 1 request per second per IP. Deliberate, not a knob worth turning up. */
export const GMGN_GAP_MS = 1100;
const GMGN_RATE_LIMIT_WAIT_MS = 3000;

export async function fetchGmgn(key: string, path: string, code: string, address: string): Promise<Rec> {
  const qs = new URLSearchParams({ chain: code, address, timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() });
  const r = await fetch(`https://openapi.gmgn.ai${path}?${qs}`, { headers: { "X-APIKEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const body: unknown = await r.json().catch(() => null);
  return gmgnData(r.ok, r.status, body);
}

const isRateLimit = (e: unknown): boolean => e instanceof Error && e.message === "RATE_LIMIT";

type InfoRead = { readonly data: Rec } | { readonly refused: string } | { readonly nothing: string };

/**
 * Their limiter is per IP and we are the only caller: a 429 means we drifted too fast, so back off
 * and retry. Anything else comes back WITH ITS REASON — it used to be dropped here, and the log said
 * only "returned nothing" for every coin of every run (17-19 Sep 2026).
 */
async function fetchInfo(key: string, code: string, address: string): Promise<InfoRead> {
  let last = "RATE_LIMIT";
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return { data: await fetchGmgn(key, "/v1/token/info", code, address) }; } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (!isRateLimit(e)) break;
      await sleep(GMGN_RATE_LIMIT_WAIT_MS);
    }
  }
  return gmgnFailure(last) === "refused" ? { refused: last } : { nothing: last };
}

/** Allowed to fail on its own: fundamentals are still stored, and `security_fetched_at` stays put so the next pass retries this half. */
async function fetchSecurity(key: string, chain: string, code: string, address: string): Promise<Security | null> {
  try { return normaliseSecurity(chain, await fetchGmgn(key, "/v1/token/security", code, address)); } catch (e) {
    if (!isRateLimit(e)) return null;
    await sleep(GMGN_RATE_LIMIT_WAIT_MS);
    try { return normaliseSecurity(chain, await fetchGmgn(key, "/v1/token/security", code, address)); } catch { return null; }
  }
}

/** Upsert one token; true when honeypot_since was stamped by this statement (first flip only, never cleared). */
export async function storeInfo(sql: Sql, t: InfoTarget, d: Rec, sec: Security | null): Promise<boolean> {
  const r = infoRow(d);
  const has = sec !== null;
  // One timestamp for the whole statement, as Postgres `now()` was: `flipped` compares against it.
  const now = new Date().toISOString();
  const honeypotAt = has && (sec.is_honeypot === true || sec.can_not_sell === true) ? now : null;
  const [row] = await sql<{ flipped: number | null }[]>`
    insert into token_info (network_id, token_key, symbol, name, price_usd, liquidity_usd,
       market_cap_usd, total_supply, circulating_supply, max_supply, holder_count,
       top_10_holder_rate, logo_url, raw, source, fetched_at,
       is_honeypot, buy_tax, sell_tax, is_open_source, is_renounced, renounced_mint,
       renounced_freeze, rug_ratio, burn_ratio, is_blacklisted, can_not_sell,
       security_fetched_at, honeypot_since)
     values (${t.network_id}, ${t.token_key}, ${r.symbol}, ${r.name}, ${r.price_usd}, ${r.liquidity_usd},
             ${r.market_cap_usd}, ${r.total_supply}, ${r.circulating_supply}, ${r.max_supply}, ${r.holder_count},
             ${r.top_10_holder_rate}, ${r.logo_url}, ${r.raw}, 'gmgn', ${now},
             ${sec?.is_honeypot ?? null}, ${sec?.buy_tax ?? null}, ${sec?.sell_tax ?? null}, ${sec?.is_open_source ?? null},
             ${sec?.is_renounced ?? null}, ${sec?.renounced_mint ?? null}, ${sec?.renounced_freeze ?? null},
             ${sec?.rug_ratio ?? null}, ${sec?.burn_ratio ?? null}, ${sec?.is_blacklisted ?? null}, ${sec?.can_not_sell ?? null},
             ${has ? now : null},
             ${honeypotAt})
     on conflict (network_id, token_key) do update set
       symbol=excluded.symbol, name=excluded.name, price_usd=excluded.price_usd,
       liquidity_usd=excluded.liquidity_usd, market_cap_usd=excluded.market_cap_usd,
       total_supply=excluded.total_supply, circulating_supply=excluded.circulating_supply,
       max_supply=excluded.max_supply, holder_count=excluded.holder_count,
       top_10_holder_rate=excluded.top_10_holder_rate, raw=excluded.raw,
       -- GMGN's logo wins; a DexScreener one (prices job) stands until GMGN has its own.
       logo_url=coalesce(excluded.logo_url, token_info.logo_url),
       fetched_at=${now},
       -- Only overwrite security when this run actually fetched it: a failed call must leave yesterday's answer standing.
       is_honeypot      = case when ${has} then excluded.is_honeypot      else token_info.is_honeypot end,
       buy_tax          = case when ${has} then excluded.buy_tax          else token_info.buy_tax end,
       sell_tax         = case when ${has} then excluded.sell_tax         else token_info.sell_tax end,
       is_open_source   = case when ${has} then excluded.is_open_source   else token_info.is_open_source end,
       is_renounced     = case when ${has} then excluded.is_renounced     else token_info.is_renounced end,
       renounced_mint   = case when ${has} then excluded.renounced_mint   else token_info.renounced_mint end,
       renounced_freeze = case when ${has} then excluded.renounced_freeze else token_info.renounced_freeze end,
       rug_ratio        = case when ${has} then excluded.rug_ratio        else token_info.rug_ratio end,
       burn_ratio       = case when ${has} then excluded.burn_ratio       else token_info.burn_ratio end,
       is_blacklisted   = case when ${has} then excluded.is_blacklisted   else token_info.is_blacklisted end,
       can_not_sell     = case when ${has} then excluded.can_not_sell     else token_info.can_not_sell end,
       -- First flip only, never cleared (Rug Dodger, C3). Same guard: a failed security call carries no flag.
       honeypot_since   = coalesce(token_info.honeypot_since,
                            case when ${has} and (excluded.is_honeypot or excluded.can_not_sell) then ${now} end),
       security_fetched_at = case when ${has} then ${now} else token_info.security_fetched_at end
     returning (honeypot_since = ${now}) as flipped`;
  return row?.flipped === 1;
}

/** GMGN had no document for this coin: remember when, so it leaves the head of the queue. */
export const recordMiss = (sql: Sql, t: InfoTarget, detail: string) => sql`
  insert into token_info_misses (network_id, token_key, missed_at, detail)
  values (${t.network_id}, ${t.token_key}, ${new Date().toISOString()}, ${detail.slice(0, 120)})
  on conflict (network_id, token_key) do update set missed_at = excluded.missed_at, detail = excluded.detail`;


/** Where a read coin goes: D1 in the Worker's job, an HTTP batch in the reader that runs elsewhere. */
export interface CoinSink {
  /** True when this store raised the coin's honeypot flag for the first time. */
  store(t: InfoTarget, d: Rec, sec: Security | null): Promise<boolean>;
  miss(t: InfoTarget, detail: string): Promise<void>;
}

export const d1Sink = (sql: Sql): CoinSink => ({
  store: (t, d, sec) => storeInfo(sql, t, d, sec),
  miss: async (t, detail) => { await recordMiss(sql, t, detail); },
});

export interface CoinsRead { readonly attempted: number; readonly ok: number; readonly errored: number; readonly unresolved: number; readonly remaining: number; readonly flipped: number }

/**
 * Read `targets` from GMGN in order, one request a second, into `sink`. Five refusals in a row end
 * the run; a coin GMGN has nothing for is a miss, not a failure. `gapMs` is the pacing, a parameter
 * only so a test need not wait a second a coin.
 */
export async function readCoins(targets: readonly InfoTarget[], key: string, outOfTime: () => boolean, sink: CoinSink, gapMs: number = GMGN_GAP_MS): Promise<CoinsRead> {
  let attempted = 0, ok = 0, errored = 0, unresolved = 0, flipped = 0, secFailed = 0, refusedInARow = 0;
  for (const t of targets) {
    if (outOfTime()) break;
    attempted += 1;
    const code = CHAIN_CODE[t.chain];
    // A chain GMGN does not cover is unresolved, not failed: no request was made and none will help.
    if (!code) { unresolved += 1; continue; }
    const read = await fetchInfo(key, code, t.address);
    if ("refused" in read) {
      errored += 1;
      refusedInARow += 1;
      console.error(`tokens: GMGN refused ${t.chain}/${t.address.slice(0, 12)}…: ${read.refused}`);
      if (refusedInARow >= REFUSALS_IN_A_ROW) {
        console.error(`tokens: GMGN refused ${refusedInARow} reads in a row (${read.refused}); leaving the rest of this run`);
        break;
      }
      await sleep(gapMs);
      continue;
    }
    refusedInARow = 0;
    if ("nothing" in read) {
      unresolved += 1;
      console.warn(`tokens: GMGN has nothing for ${t.chain}/${t.address.slice(0, 12)}…: ${read.nothing}`);
      await sink.miss(t, read.nothing);
      await sleep(gapMs);
      continue;
    }
    // Security is a second endpoint, so a second request and a second second of pacing.
    await sleep(gapMs);
    const sec = await fetchSecurity(key, t.chain, code, t.address);
    if (!sec) secFailed += 1;
    try {
      if (await sink.store(t, read.data, sec)) flipped += 1;
      ok += 1;
    } catch (e) {
      // One unstorable token must not end the run; `fetched_at` stays null so the next pass retries it.
      errored += 1;
      console.error(`tokens: ${t.chain}/${t.address.slice(0, 10)}… store failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(gapMs);
  }
  if (secFailed) console.log(`tokens: ${secFailed} token(s) stored without security`);
  return { attempted, ok, errored, unresolved, remaining: targets.length - attempted, flipped };
}

// --------------------------------------------------------------- GMGN: results read elsewhere, written here
/** One coin as the outside reader reports it: GMGN's document with the normalised security block, or the reason there is none. */
export type RelayResult =
  | { readonly network_id: number; readonly token_key: string; readonly chain: string; readonly info: Rec; readonly security: Security | null }
  | { readonly network_id: number; readonly token_key: string; readonly chain: string; readonly nothing: string };

/** Results accepted per POST: the Worker writes one statement a coin, and a request has 11 s. */
export const RELAY_BATCH_MAX = 50;
const SECURITY_FLAGS = ["is_honeypot", "is_open_source", "is_renounced", "renounced_mint", "renounced_freeze", "is_blacklisted", "can_not_sell"] as const;
const SECURITY_RATES = ["buy_tax", "sell_tax", "rug_ratio", "burn_ratio"] as const;

const asSecurity = (v: unknown): Security | null | "bad" => {
  if (v === null || v === undefined) return null;
  if (!isRec(v)) return "bad";
  for (const k of SECURITY_FLAGS) if (v[k] !== null && v[k] !== undefined && typeof v[k] !== "boolean") return "bad";
  for (const k of SECURITY_RATES) if (v[k] !== null && v[k] !== undefined && (typeof v[k] !== "number" || !Number.isFinite(v[k]))) return "bad";
  return Object.fromEntries([...SECURITY_FLAGS, ...SECURITY_RATES].map((k) => [k, v[k] ?? null])) as unknown as Security;
};

/** The body of `POST /jobs/gmgn_results`, checked field by field: it arrives from outside and becomes rows. */
export function parseRelayResults(body: unknown): { readonly ok: RelayResult[]; readonly rejected: { index: number; why: string }[] } {
  const list = isRec(body) && Array.isArray(body.results) ? body.results : null;
  if (!list) return { ok: [], rejected: [{ index: -1, why: "body must be { results: [...] }" }] };
  if (list.length > RELAY_BATCH_MAX) return { ok: [], rejected: [{ index: -1, why: `at most ${RELAY_BATCH_MAX} results a request, got ${list.length}` }] };
  const ok: RelayResult[] = [], rejected: { index: number; why: string }[] = [];
  list.forEach((r: unknown, index: number) => {
    if (!isRec(r)) return void rejected.push({ index, why: "not an object" });
    const { network_id, token_key, chain } = r;
    if (typeof network_id !== "number" || !Number.isInteger(network_id)) return void rejected.push({ index, why: "network_id must be an integer" });
    if (typeof token_key !== "string" || !token_key || token_key.length > 100) return void rejected.push({ index, why: "token_key must be a string of 1-100 characters" });
    if (typeof chain !== "string" || !(chain in CHAIN_CODE)) return void rejected.push({ index, why: `chain must be one of ${Object.keys(CHAIN_CODE).join(", ")}` });
    if (typeof r.nothing === "string") return void ok.push({ network_id, token_key, chain, nothing: r.nothing.slice(0, 120) });
    if (!isRec(r.info)) return void rejected.push({ index, why: "either nothing (a string) or info (GMGN's document) is required" });
    const security = asSecurity(r.security);
    if (security === "bad") return void rejected.push({ index, why: "security must be null or the normalised block (booleans and finite numbers)" });
    ok.push({ network_id, token_key, chain, info: r.info, security });
  });
  return { ok, rejected };
}

export interface RelayApplied { readonly stored: number; readonly missed: number; readonly flipped: number; readonly unknown: number }

/** Write what the outside reader read. A coin we do not hold a `tokens` row for is refused: nothing here creates coins. */
export async function applyRelayResults(sql: Sql, results: readonly RelayResult[]): Promise<RelayApplied> {
  let stored = 0, missed = 0, flipped = 0, unknown = 0;
  for (const r of results) {
    const [known] = await sql<{ address: string }[]>`select address from tokens where network_id = ${r.network_id} and token_key = ${r.token_key}`;
    if (!known) { unknown += 1; continue; }
    const t: InfoTarget = { network_id: r.network_id, token_key: r.token_key, address: known.address, chain: r.chain };
    if ("nothing" in r) { await recordMiss(sql, t, r.nothing); missed += 1; continue; }
    if (await storeInfo(sql, t, r.info, r.security)) flipped += 1;
    stored += 1;
  }
  return { stored, missed, flipped, unknown };
}
