import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { bitquery } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/settings.ts";
import {
  CHAIN_CODE, type Rec, type Security, type Supply, chainHits, evmSupply, gmgnData, infoRow,
  isEvmAddress, isSolAddress, normaliseSecurity, singleChain, solanaSupply,
} from "./tokens-core";

/**
 * Token refresh, the Worker half of three refresh.yml steps, in their order:
 *   1. `scripts/resolve_trade_chains.mjs`  a chain for traded-but-no-longer-held tokens
 *   2. `scripts/load_token_supply.mjs`     total supply so an entry price can be a market cap
 *   3. `scripts/load_token_info.mjs --stale-hours 20`  GMGN fundamentals + security
 *
 * TWINS of those scripts: edit both. Same SQL, same target order, same bookkeeping (a
 * resolved chain, a stored supply, `token_info.fetched_at` are what take a token off the
 * list), so a run cut short by the budget resumes where it stopped. Differs where the
 * platform does: writes land per chunk rather than at the end, a failed unit is counted
 * rather than fatal, no CLI flags, and chain + supply come from Bitquery, not JSON-RPC (no
 * public node is called from the Worker, decision of 18 Sep 2026; see `_shared/bitquery.ts`).
 */

type Sql = postgres.Sql;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EVM_IDS = Object.keys(EVM_CHAINS).map(Number);
const CHAIN_FANOUT = 6;
const SUPPLY_FANOUT = 5;
const STALE_HOURS = 20;
/** GMGN: 1 request per second per IP. Deliberate, not a knob worth turning up. */
const GMGN_GAP_MS = 1100;
const GMGN_RATE_LIMIT_WAIT_MS = 3000;

export interface TokensSummary {
  readonly chainsResolved: number;
  readonly supplyResolved: number;
  readonly infoRefreshed: number;
  /** token_info rows whose honeypot_since was stamped this run (first flip only). */
  readonly honeypotFlipped: number;
  /** Units attempted that produced no write: unresolvable chain, unreadable supply, failed GMGN fetch or store. */
  readonly errored: number;
  /** Units across the three phases never attempted because the budget ran out. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

interface Phase { readonly attempted: number; readonly ok: number; readonly errored: number; readonly remaining: number }

// ------------------------------------------------------------- 1. trade chains
/**
 * One request probes every EVM chain: an `EVM` root per chain (aliased `n<id>`), each asking
 * for a single transfer of the contract. A traded token has transferred at least once, so a
 * row means "lives here". Shape per
 * https://docs.bitquery.io/docs/blockchain/Ethereum/transfers/erc20-token-transfer-api/
 * (`Transfers(where: {Transfer: {Currency: {SmartContract: {is}}}}, limit: {count})`), on
 * `dataset: realtime` so old tokens count too.
 */
const CHAIN_PROBE = `query ($addr: String!) {
${EVM_IDS.map((id) => `  n${id}: EVM(network: ${EVM_CHAINS[id].bitquery}, dataset: realtime) {
    Transfers(where: { Transfer: { Currency: { SmartContract: { is: $addr } } } }, limit: { count: 1 }) {
      Transfer { Currency { SmartContract } }
    }
  }`).join("\n")}
}`;

/** Every EVM chain on which Bitquery has seen the contract; null when the probe failed. Shared with the directory job. */
export async function evmChainsSeen(key: string, address: string): Promise<readonly number[] | null> {
  try {
    return chainHits(await bitquery(key, CHAIN_PROBE, { addr: address.toLowerCase() }), EVM_IDS);
  } catch (e) {
    console.error(`tokens: chain probe for ${address.slice(0, 10)}… failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** base58 shape is Solana; 0x is probed on every EVM chain at once. Unanswered is unresolved: retried next run. */
async function chainFor(key: string, address: string): Promise<number | null> {
  if (isSolAddress(address)) return SOLANA_NETWORK_ID;
  if (!isEvmAddress(address)) return null;
  const hits = await evmChainsSeen(key, address);
  return hits === null ? null : singleChain(hits);
}

async function resolveChains(sql: Sql, key: string, outOfTime: () => boolean): Promise<Phase> {
  const rows = await sql<{ token_address: string; token_key: string }[]>`
    select distinct token_address, token_key from trades
    where network_id is null and token_address is not null`;
  let attempted = 0, ok = 0, errored = 0;
  for (let i = 0; i < rows.length && !outOfTime(); i += CHAIN_FANOUT) {
    const chunk = rows.slice(i, i + CHAIN_FANOUT);
    const nets = await Promise.all(chunk.map((t) => chainFor(key, t.token_address)));
    for (const [k, t] of chunk.entries()) {
      attempted += 1;
      const net = nets[k];
      if (net === null) { errored += 1; continue; }
      try {
        // The token may be new to us entirely; create it before pointing trades at it.
        await sql`insert into tokens (network_id, address) values (${net}, ${t.token_address})
                  on conflict (network_id, token_key) do nothing`;
        await sql`update trades set network_id = ${net} where token_key = ${t.token_key} and network_id is null`;
        ok += 1;
      } catch (e) {
        errored += 1;
        console.error(`tokens: chain write for ${t.token_key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { attempted, ok, errored, remaining: rows.length - attempted };
}

// ------------------------------------------------------------------ 2. supply
interface SupplyTarget { readonly network_id: number; readonly address: string; readonly token_key: string }

/**
 * Latest total supply after the token's most recent transaction, per
 * https://docs.bitquery.io/docs/blockchain/Ethereum/token-supply/evm-token-supply/ and
 * https://docs.bitquery.io/docs/blockchain/Ethereum/transfers/total-supply/
 * (`TransactionBalances { TokenBalance { TotalSupply Currency { Decimals } } }`). Bitquery
 * returns the supply already scaled by `Decimals`, as its `Balance.Amount` is; the ERC-20
 * `totalSupply()` word is no longer read.
 */
const EVM_SUPPLY = (network: string): string => `query ($addr: String!) {
  EVM(network: ${network}, dataset: realtime) {
    TransactionBalances(limit: { count: 1 }, orderBy: { descending: Block_Time },
                        where: { TokenBalance: { Currency: { SmartContract: { is: $addr } } } }) {
      TokenBalance { TotalSupply Currency { Symbol Name Decimals } }
    }
  }
}`;

/** https://docs.bitquery.io/docs/blockchain/Solana/token-supply-cube/ : `PostBalance` is the supply after the latest mint or burn. */
const SOLANA_SUPPLY = `query ($mint: String!) {
  Solana {
    TokenSupplyUpdates(limit: { count: 1 }, orderBy: { descending: Block_Time },
                       where: { TokenSupplyUpdate: { Currency: { MintAddress: { is: $mint } } } }) {
      TokenSupplyUpdate { PostBalance Currency { Symbol Decimals } }
    }
  }
}`;

async function readSupply(key: string, t: SupplyTarget): Promise<Supply | null> {
  if (t.network_id === SOLANA_NETWORK_ID) return solanaSupply(await bitquery(key, SOLANA_SUPPLY, { mint: t.address }));
  const cfg = EVM_CHAINS[t.network_id];
  if (!cfg) return null;
  return evmSupply(await bitquery(key, EVM_SUPPLY(cfg.bitquery), { addr: t.address.toLowerCase() }));
}

async function resolveSupply(sql: Sql, key: string, outOfTime: () => boolean): Promise<Phase> {
  // Only tokens where a supply would actually be used: an entry price exists, or somebody holds it.
  // The most valuable held position first (gross amount x price, ceilings or not): a supply is what
  // lets /positions run the implied-cap check on exactly those rows (V1b).
  const rows = await sql<{ network_id: string; address: string; token_key: string }[]>`
    select tk.network_id, tk.address, tk.token_key
    from tokens tk
    left join lateral (
      select max(h.human_amount * h.price) as held from holdings_current h
      where h.network_id = tk.network_id and h.token_key = tk.token_key) hv on true
    where tk.total_supply is null
      and (exists (select 1 from trades t
                   where t.network_id = tk.network_id and t.token_key = tk.token_key
                     and t.avg_entry_price > 0)
           or exists (select 1 from holdings_current h
                      where h.network_id = tk.network_id and h.token_key = tk.token_key))
    order by hv.held desc nulls last, tk.network_id, tk.address`;
  const targets: SupplyTarget[] = rows.map((r) => ({ ...r, network_id: Number(r.network_id) }));
  let attempted = 0, ok = 0, errored = 0;
  for (let i = 0; i < targets.length && !outOfTime(); i += SUPPLY_FANOUT) {
    const chunk = targets.slice(i, i + SUPPLY_FANOUT);
    const read = await Promise.all(chunk.map((t) => readSupply(key, t).catch(() => null)));
    const found = chunk.flatMap((t, k) => { const s = read[k]; return s ? [{ t, s }] : []; });
    attempted += chunk.length;
    errored += chunk.length - found.length;
    if (!found.length) continue;
    try {
      await sql`
        update tokens t set total_supply = u.s, decimals = u.d, supply_source = u.src, supply_read_at = now()
        from unnest(${found.map((f) => f.s.supply)}::numeric[], ${found.map((f) => f.s.decimals)}::integer[],
                    ${found.map((f) => f.s.source)}::text[], ${found.map((f) => f.t.network_id)}::bigint[],
                    ${found.map((f) => f.t.token_key)}::text[]) as u(s, d, src, n, k)
        where t.network_id = u.n and t.token_key = u.k`;
      ok += found.length;
    } catch (e) {
      errored += found.length;
      console.error(`tokens: supply write for ${found.length} tokens failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { attempted, ok, errored, remaining: targets.length - attempted };
}

// --------------------------------------------------------------- 3. token_info
interface InfoTarget { readonly network_id: string; readonly token_key: string; readonly address: string; readonly chain: string }

async function fetchGmgn(key: string, path: string, code: string, address: string): Promise<Rec> {
  const qs = new URLSearchParams({ chain: code, address, timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() });
  const r = await fetch(`https://openapi.gmgn.ai${path}?${qs}`, { headers: { "X-APIKEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  const body: unknown = await r.json().catch(() => null);
  return gmgnData(r.ok, r.status, body);
}

const isRateLimit = (e: unknown): boolean => e instanceof Error && e.message === "RATE_LIMIT";

/** Their limiter is per IP and we are the only caller: a 429 means we drifted too fast, so back off and retry; anything else is this token's problem. */
async function fetchInfo(key: string, code: string, address: string): Promise<Rec | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetchGmgn(key, "/v1/token/info", code, address); } catch (e) {
      if (isRateLimit(e)) { await sleep(GMGN_RATE_LIMIT_WAIT_MS); continue; }
      if (attempt === 2) console.error(`tokens: ${code}/${address.slice(0, 10)}… ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
  return null;
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
async function storeInfo(sql: Sql, t: InfoTarget, d: Rec, sec: Security | null): Promise<boolean> {
  const r = infoRow(d);
  const has = sec !== null;
  const [row] = await sql<{ flipped: boolean | null }[]>`
    insert into token_info (network_id, token_key, symbol, name, price_usd, liquidity_usd,
       market_cap_usd, total_supply, circulating_supply, max_supply, holder_count,
       top_10_holder_rate, raw, source, fetched_at,
       is_honeypot, buy_tax, sell_tax, is_open_source, is_renounced, renounced_mint,
       renounced_freeze, rug_ratio, burn_ratio, is_blacklisted, can_not_sell,
       security_fetched_at, honeypot_since)
     values (${t.network_id}, ${t.token_key}, ${r.symbol}, ${r.name}, ${r.price_usd}, ${r.liquidity_usd},
             ${r.market_cap_usd}, ${r.total_supply}, ${r.circulating_supply}, ${r.max_supply}, ${r.holder_count},
             ${r.top_10_holder_rate}, ${r.raw}::jsonb, 'gmgn', now(),
             ${sec?.is_honeypot ?? null}, ${sec?.buy_tax ?? null}, ${sec?.sell_tax ?? null}, ${sec?.is_open_source ?? null},
             ${sec?.is_renounced ?? null}, ${sec?.renounced_mint ?? null}, ${sec?.renounced_freeze ?? null},
             ${sec?.rug_ratio ?? null}, ${sec?.burn_ratio ?? null}, ${sec?.is_blacklisted ?? null}, ${sec?.can_not_sell ?? null},
             case when ${has}::boolean then now() else null end,
             case when ${has}::boolean and (${sec?.is_honeypot ?? null}::boolean or ${sec?.can_not_sell ?? null}::boolean) then now() end)
     on conflict (network_id, token_key) do update set
       symbol=excluded.symbol, name=excluded.name, price_usd=excluded.price_usd,
       liquidity_usd=excluded.liquidity_usd, market_cap_usd=excluded.market_cap_usd,
       total_supply=excluded.total_supply, circulating_supply=excluded.circulating_supply,
       max_supply=excluded.max_supply, holder_count=excluded.holder_count,
       top_10_holder_rate=excluded.top_10_holder_rate, raw=excluded.raw,
       fetched_at=now(),
       -- Only overwrite security when this run actually fetched it: a failed call must leave yesterday's answer standing.
       is_honeypot      = case when ${has}::boolean then excluded.is_honeypot      else token_info.is_honeypot end,
       buy_tax          = case when ${has}::boolean then excluded.buy_tax          else token_info.buy_tax end,
       sell_tax         = case when ${has}::boolean then excluded.sell_tax         else token_info.sell_tax end,
       is_open_source   = case when ${has}::boolean then excluded.is_open_source   else token_info.is_open_source end,
       is_renounced     = case when ${has}::boolean then excluded.is_renounced     else token_info.is_renounced end,
       renounced_mint   = case when ${has}::boolean then excluded.renounced_mint   else token_info.renounced_mint end,
       renounced_freeze = case when ${has}::boolean then excluded.renounced_freeze else token_info.renounced_freeze end,
       rug_ratio        = case when ${has}::boolean then excluded.rug_ratio        else token_info.rug_ratio end,
       burn_ratio       = case when ${has}::boolean then excluded.burn_ratio       else token_info.burn_ratio end,
       is_blacklisted   = case when ${has}::boolean then excluded.is_blacklisted   else token_info.is_blacklisted end,
       can_not_sell     = case when ${has}::boolean then excluded.can_not_sell     else token_info.can_not_sell end,
       -- First flip only, never cleared (Rug Dodger, C3). Same guard: a failed security call carries no flag.
       honeypot_since   = coalesce(token_info.honeypot_since,
                            case when ${has}::boolean and (excluded.is_honeypot or excluded.can_not_sell) then now() end),
       security_fetched_at = case when ${has}::boolean then now() else token_info.security_fetched_at end
     returning (honeypot_since = now()) as flipped`;
  return row?.flipped === true;
}

async function refreshInfo(sql: Sql, env: Env, outOfTime: () => boolean): Promise<Phase & { flipped: number }> {
  const targets = await sql<InfoTarget[]>`
    select h.network_id, h.token_key, tk.address, ch.name as chain
      from holdings_current h
      join tokens tk  on tk.network_id = h.network_id and tk.token_key = h.token_key
      join chains ch  on ch.network_id = h.network_id
      left join quote_assets q
        on q.network_id = h.network_id and q.token_key = h.token_key
      left join token_info ti
        on ti.network_id = h.network_id and ti.token_key = h.token_key
     where q.token_key is null
       -- Either half being stale is reason to refetch: security has its own timestamp.
       and (ti.fetched_at is null or ti.security_fetched_at is null
            or ti.fetched_at < now() - (${STALE_HOURS} * interval '1 hour')
            or ti.security_fetched_at < now() - (${STALE_HOURS} * interval '1 hour'))
     group by 1,2,3,4, ti.fetched_at, ti.security_fetched_at
     -- Never-fetched first, then stalest: a run cut short leaves the set more complete than it found it.
     order by ti.security_fetched_at asc nulls first, ti.fetched_at asc nulls first, h.token_key`;
  const key = (env.GMGN_API_KEY ?? "").trim();
  if (targets.length && !key) throw new Error("GMGN_API_KEY is not set");
  let attempted = 0, ok = 0, errored = 0, flipped = 0, secFailed = 0;
  for (const t of targets) {
    if (outOfTime()) break;
    attempted += 1;
    const code = CHAIN_CODE[t.chain];
    const d = code ? await fetchInfo(key, code, t.address) : null;
    if (!d || !code) { errored += 1; await sleep(GMGN_GAP_MS); continue; }
    // Security is a second endpoint, so a second request and a second second of pacing.
    await sleep(GMGN_GAP_MS);
    const sec = await fetchSecurity(key, t.chain, code, t.address);
    if (!sec) secFailed += 1;
    try {
      if (await storeInfo(sql, t, d, sec)) flipped += 1;
      ok += 1;
    } catch (e) {
      // One unstorable token must not end the run; `fetched_at` stays null so the next pass retries it.
      errored += 1;
      console.error(`tokens: ${t.chain}/${t.address.slice(0, 10)}… store failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(GMGN_GAP_MS);
  }
  if (secFailed) console.log(`tokens: ${secFailed} token(s) stored without security`);
  return { attempted, ok, errored, remaining: targets.length - attempted, flipped };
}

/**
 * The three phases in order, each within what is left of `budgetMs`. Throws only when work
 * was attempted and none of it landed, so the cron shows as failed.
 */
export async function runTokens(env: Env, budgetMs: number): Promise<TokensSummary> {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > budgetMs;
  const bitqueryKey = (env.BITQUERY_KEY ?? "").trim();
  if (!bitqueryKey) throw new Error("tokens: BITQUERY_KEY is not set; chains and supply are read through Bitquery");
  const sql = db(env);
  try {
    const chains = await resolveChains(sql, bitqueryKey, outOfTime);
    const supply = await resolveSupply(sql, bitqueryKey, outOfTime);
    const info = await refreshInfo(sql, env, outOfTime);
    const phases = [chains, supply, info];
    const attempted = phases.reduce((n, p) => n + p.attempted, 0);
    const errored = phases.reduce((n, p) => n + p.errored, 0);
    const remaining = phases.reduce((n, p) => n + p.remaining, 0);
    if (attempted > 0 && errored === attempted) throw new Error(`tokens: all ${attempted} units failed`);
    return {
      chainsResolved: chains.ok,
      supplyResolved: supply.ok,
      infoRefreshed: info.ok,
      honeypotFlipped: info.flipped,
      errored,
      remaining,
      stoppedEarly: remaining > 0,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
