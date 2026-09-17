import { SOLANA_NETWORK_ID } from "../../../supabase/functions/_shared/chain_reads.ts";

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

/** Solana base58 is case sensitive; only the KEY is lowercased, matching tokens.token_key. */
export function positionRows(handle: string, net: number, balances: readonly Balance[]): Row[] {
  return balances.map((b) => ({ handle, network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: b.amount }));
}
