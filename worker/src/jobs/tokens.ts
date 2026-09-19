import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { bitquery } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/settings.ts";
import {
  chainHits, d1Sink, evmSupply, GMGN_MISS_RETRY_AGO, GMGN_STALE_AGO, infoTargets, isEvmAddress,
  isSolAddress, readCoins, singleChain, solanaSupply, type Supply, type SupplyTarget,
  supplyTargets,
} from "./tokens-core";

/**
 * Token refresh, the Worker half of three refresh.yml steps, in their order:
 *   1. `scripts/resolve_trade_chains.mjs`  a chain for traded-but-no-longer-held tokens
 *   2. `scripts/load_token_supply.mjs`     total supply so an entry price can be a market cap
 *   3. `scripts/load_token_info.mjs --stale-hours 20`  GMGN fundamentals + security
 *
 * TWINS of those scripts: edit both. Same rows, same target order, same bookkeeping (a
 * resolved chain, a stored supply, `token_info.fetched_at` are what take a token off the
 * list), so a run cut short by the budget resumes where it stopped. Differs where the
 * platform does: writes land per chunk rather than at the end, a failed unit is counted
 * rather than fatal, no CLI flags, and chain + supply come from Bitquery, not JSON-RPC (no
 * public node is called from the Worker, decision of 17 Sep 2026; see `_shared/bitquery.ts`).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EVM_IDS = Object.keys(EVM_CHAINS).map(Number);
const CHAIN_FANOUT = 6;
const SUPPLY_FANOUT = 5;
/** Targets built per run. Bitquery paces about 50 reads a minute, so a larger list only costs the
 *  group-by that builds it — which, unbounded, used the whole phase budget (17 Sep 2026). */
const SUPPLY_SLICE = 400;

export interface TokensSummary {
  readonly chainsResolved: number;
  readonly supplyResolved: number;
  readonly infoRefreshed: number;
  /** token_info rows whose honeypot_since was stamped this run (first flip only). */
  readonly honeypotFlipped: number;
  /** Units attempted whose source call or write FAILED. A source that answered "nothing here" is `unresolved`. */
  readonly errored: number;
  /** Units a source answered for with no usable value: a contract on no or several chains, a token with no
   *  supply row yet. Not a failure: retried next run, and never trips the all-failed guard. */
  readonly unresolved: number;
  /** Units across the three phases never attempted because the budget ran out. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

interface Phase { readonly attempted: number; readonly ok: number; readonly errored: number; readonly unresolved: number; readonly remaining: number }

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

/**
 * base58 shape is Solana; 0x is probed on every EVM chain at once. `"failed"` is a probe that did not
 * answer; `null` is an answer that names no single chain (no hits, several hits, or an address of
 * neither shape) — not a failure, so it does not count against the all-failed guard.
 */
async function chainFor(key: string, address: string): Promise<number | null | "failed"> {
  if (isSolAddress(address)) return SOLANA_NETWORK_ID;
  if (!isEvmAddress(address)) return null;
  const hits = await evmChainsSeen(key, address);
  return hits === null ? "failed" : singleChain(hits);
}

async function resolveChains(sql: Sql, key: string, outOfTime: () => boolean): Promise<Phase> {
  const rows = await sql<{ token_address: string; token_key: string }[]>`
    select distinct token_address, token_key from trades
    where network_id is null and token_address is not null`;
  let attempted = 0, ok = 0, errored = 0, unresolved = 0;
  for (let i = 0; i < rows.length && !outOfTime(); i += CHAIN_FANOUT) {
    const chunk = rows.slice(i, i + CHAIN_FANOUT);
    const nets = await Promise.all(chunk.map((t) => chainFor(key, t.token_address)));
    for (const [k, t] of chunk.entries()) {
      attempted += 1;
      const net = nets[k];
      if (net === "failed") { errored += 1; continue; }
      if (net === null) { unresolved += 1; continue; }
      try {
        // The token may be new to us entirely; create it before pointing trades at it.
        // token_key is a plain column in D1, so lower(address) is passed, not generated.
        await sql`insert into tokens (network_id, address, token_key)
                  values (${net}, ${t.token_address}, lower(${t.token_address}))
                  on conflict (network_id, token_key) do nothing`;
        await sql`update trades set network_id = ${net} where token_key = ${t.token_key} and network_id is null`;
        ok += 1;
      } catch (e) {
        errored += 1;
        console.error(`tokens: chain write for ${t.token_key} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { attempted, ok, errored, unresolved, remaining: rows.length - attempted };
}

// ------------------------------------------------------------------ 2. supply
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
  const targets = await supplyTargets(sql, SUPPLY_SLICE);
  let attempted = 0, ok = 0, errored = 0, unresolved = 0;
  for (let i = 0; i < targets.length && !outOfTime(); i += SUPPLY_FANOUT) {
    const chunk = targets.slice(i, i + SUPPLY_FANOUT);
    // A read that throws is one failed token, not a dead run, and its message is logged: a silent
    // null hid a GraphQL schema error behind 694 "errored" counts (17 Sep 2026). A read that
    // answers with no supply row is `undefined` here, and counts as unresolved, not failed.
    const read = await Promise.all(chunk.map((t) => readSupply(key, t).catch((e: unknown) => {
      console.error(`tokens: supply read for ${t.address.slice(0, 12)}… on ${t.network_id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    })));
    const found = chunk.flatMap((t, k) => { const s = read[k]; return s ? [{ t, s }] : []; });
    attempted += chunk.length;
    errored += read.filter((r) => r === undefined).length;
    unresolved += read.filter((r) => r === null).length;
    if (!found.length) continue;
    try {
      // One update per token, all in one batch: SQLite has no unnest, and SUPPLY_FANOUT rows
      // x 5 bound values stays far inside D1's 100-parameter ceiling.
      await sql.begin((tx) => {
        for (const f of found) {
          tx`update tokens set total_supply = ${f.s.supply}, decimals = ${f.s.decimals},
                 supply_source = ${f.s.source}, supply_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               where network_id = ${f.t.network_id} and token_key = ${f.t.token_key}`;
        }
      });
      ok += found.length;
    } catch (e) {
      errored += found.length;
      console.error(`tokens: supply write for ${found.length} tokens failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { attempted, ok, errored, unresolved, remaining: targets.length - attempted };
}

// --------------------------------------------------------------- 3. token_info

async function refreshInfo(sql: Sql, env: Env, outOfTime: () => boolean): Promise<Phase & { flipped: number }> {
  const targets = await infoTargets(sql, GMGN_STALE_AGO, GMGN_MISS_RETRY_AGO);
  const key = (env.GMGN_API_KEY ?? "").trim();
  if (targets.length && !key) throw new Error("GMGN_API_KEY is not set");
  return readCoins(targets, key, outOfTime, d1Sink(sql));
}

/**
 * The three phases in order, each within what is left of `budgetMs`. Throws only when work
 * was attempted and none of it landed, so the cron shows as failed.
 */
export async function runTokens(env: Env, budgetMs: number): Promise<TokensSummary> {
  const started = Date.now();
  // A cumulative deadline per phase. The chain probe has a 58k backlog that a realtime-only Bitquery
  // plan will never finish, and a single shared deadline let it eat every run, so supply and
  // token_info never ran (17 Sep 2026). Shares are cumulative: the phases run in order.
  const outOfTime = (share: number) => () => Date.now() - started > budgetMs * share;
  const bitqueryKey = (env.BITQUERY_KEY ?? "").trim();
  if (!bitqueryKey) throw new Error("tokens: BITQUERY_KEY is not set; chains and supply are read through Bitquery");
  const sql = jobSql(env);
  try {
    // GMGN FIRST, with half the run (19 Sep 2026): it is the one phase a consumer reads the date of,
    // and last in line it got 40% of whatever the two Bitquery phases left.
    const info = await refreshInfo(sql, env, outOfTime(0.5));
    const supply = await resolveSupply(sql, bitqueryKey, outOfTime(0.9));
    const chains = await resolveChains(sql, bitqueryKey, outOfTime(1));
    const phases = [supply, chains, info];
    const attempted = phases.reduce((n, p) => n + p.attempted, 0);
    const errored = phases.reduce((n, p) => n + p.errored, 0);
    const unresolved = phases.reduce((n, p) => n + p.unresolved, 0);
    const remaining = phases.reduce((n, p) => n + p.remaining, 0);
    if (attempted > 0 && errored === attempted) throw new Error(`tokens: all ${attempted} units failed`);
    return {
      chainsResolved: chains.ok,
      supplyResolved: supply.ok,
      infoRefreshed: info.ok,
      honeypotFlipped: info.flipped,
      errored,
      unresolved,
      remaining,
      stoppedEarly: remaining > 0,
      elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
