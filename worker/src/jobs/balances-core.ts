import { SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";

/**
 * Pure parts of the chain-balance job (`balances.ts`): which chains a trader can be asked on,
 * and how a chain's answer becomes holdings rows. No I/O: tested in tests/balances_test.ts.
 */

export const DEFAULT_SLICE = 25;

export interface Chain { readonly network_id: number; readonly name: string; readonly rpc: string }
export interface Trader { readonly handle: string; readonly sol_address: string | null; readonly evm_address: string | null }
export interface Traded { readonly token_key: string; readonly address: string }
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

/** Key for the per-(trader, chain) traded-token lists, as the .mjs builds it. */
export const tradedKey = (handle: string, net: number): string => `${handle}|${net}`;

/**
 * The chains one trader is asked on: Solana whenever he has that wallet (it lists everything
 * held), an EVM chain only when he has that wallet AND has traded something there (the read
 * is scoped to traded tokens, so nothing to ask for is nothing to read). Same rule as the .mjs loop.
 */
export function askable(t: Trader, chains: readonly Chain[], traded: ReadonlyMap<string, readonly Traded[]>): Chain[] {
  return chains.filter((c) =>
    c.network_id === SOLANA_NETWORK_ID
      ? t.sol_address !== null
      : t.evm_address !== null && (traded.get(tradedKey(t.handle, c.network_id))?.length ?? 0) > 0);
}

/** Solana base58 is case sensitive; only the KEY is lowercased, matching tokens.token_key. */
export function positionRows(handle: string, net: number, balances: readonly Balance[]): Row[] {
  return balances.map((b) => ({ handle, network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: b.amount }));
}
