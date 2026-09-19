import { SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";
import type { Sql } from "../d1.ts";

/**
 * Pure parts of the chain-balance job (`balances.ts`): which chains a trader can be asked on,
 * and how a chain's answer becomes holdings rows. No I/O: tested in tests/balances_test.ts.
 */

export const DEFAULT_SLICE = 25;

export interface Chain { readonly network_id: number; readonly name: string; readonly rpc: string }
export interface Trader { readonly handle: string; readonly sol_address: string | null; readonly evm_address: string | null }
export interface Balance { readonly address: string; readonly amount: string }
/** One holdings row before pricing, exactly the tuple the .mjs collects in `rowsOut`. */
export interface Row {
  readonly handle: string;
  readonly network_id: number;
  readonly token_key: string;
  readonly address: string;
  readonly amount: string;
}

/** `env.BALANCE_SLICE`, or the default when unset or not a positive integer. */
export function sliceSize(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SLICE;
}

/**
 * The chains one trader is asked on: every chain he has the wallet for. Both reads list
 * everything held (Helius for Solana, Bitquery for EVM), so no traded-token list gates an ask.
 */
export function askable(t: Trader, chains: readonly Chain[]): Chain[] {
  return chains.filter((c) => (c.network_id === SOLANA_NETWORK_ID ? t.sol_address : t.evm_address) !== null);
}

/** Who answers for a chain: Helius for Solana, Bitquery for every EVM chain. */
export type Source = "helius" | "bitquery";
export const sourceOf = (c: Chain): Source => (c.network_id === SOLANA_NETWORK_ID ? "helius" : "bitquery");

/**
 * Traders in a row for whom a source answered NONE of the chains asked of it, after one more trader:
 * any answer resets its count, and a trader not asked on it leaves the count as it was.
 */
export function failedInARow(before: Readonly<Record<Source, number>>, asked: readonly Chain[], answered: readonly boolean[]): Record<Source, number> {
  const after = (s: Source): number => {
    const mine = answered.filter((_, i) => sourceOf(asked[i]) === s);
    return mine.length === 0 ? before[s] : mine.some(Boolean) ? 0 : before[s] + 1;
  };
  return { helius: after("helius"), bitquery: after("bitquery") };
}

/** Solana base58 is case sensitive; only the KEY is lowercased, matching tokens.token_key. */
export function positionRows(handle: string, net: number, balances: readonly Balance[]): Row[] {
  return balances.map((b) => ({ handle, network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: b.amount }));
}

/**
 * The queue: longest-unattempted first (`wallets.balances_read_at`), never attempted first. It was
 * ordered by the newest holdings row, which only a SUCCESS writes, so a refused or emptied wallet
 * kept its slot at the head for ever. Here, not in balances.ts, so tests/balances_queue_test.ts runs it.
 */
export const balanceTargets = (sql: Sql, limit: number) => sql<Trader[]>`
    select t.handle, w.sol_address, w.evm_address
    from traders t
    join wallets w on w.handle = t.handle
    where w.sol_address is not null or w.evm_address is not null
    order by coalesce(w.balances_read_at, ''), t.handle
    limit ${limit}`;

/** Stamped for every trader ATTEMPTED, answered or not: the attempt is what sends him to the back. */
export const stampAttempt = (sql: Sql, handle: string, at: string) => sql`
    update wallets set balances_read_at = ${at} where handle = ${handle}`;

/** Traders with a wallet that no run has attempted since `at`. */
export const notAttemptedSince = (sql: Sql, at: string) => sql<{ n: number }[]>`
    select count(*) as n
    from traders t
    join wallets w on w.handle = t.handle
    where (w.sol_address is not null or w.evm_address is not null)
      and (w.balances_read_at is null or w.balances_read_at < ${at})`;
