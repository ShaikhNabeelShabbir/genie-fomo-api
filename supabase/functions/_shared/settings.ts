// The only copy since 17 Sep 2026 (the scripts/ twin was deleted with the GitHub loaders).
/**
 * Provider constants shared by the transfer fetch. No env reads here: keys are passed in by
 * the caller (`ProviderKeys` in transactions.ts), so the same module runs under Deno and the
 * Cloudflare Worker.
 */
export { SOLANA_NETWORK_ID } from "./chain_reads.ts";

export interface EvmChain {
  readonly name: string;
  readonly bitquery: string;
  /** null where no usable instance exists — BSC has none, Base's returns 500s. */
  readonly rpc: string;
  readonly explorer: string;
  /** Gas token — what a fee is denominated in, and the native leg of a swap. */
  readonly nativeSymbol: string;
}

export const EVM_CHAINS: Readonly<Record<number, EvmChain>> = {
  4663: {
    name: "robinhood",
    bitquery: "robinhood",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
  },
  1: {
    name: "ethereum",
    bitquery: "eth",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    nativeSymbol: "ETH",
  },
  56: {
    name: "bsc",
    bitquery: "bsc",
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
    nativeSymbol: "BNB",
  },
  8453: {
    name: "base",
    bitquery: "base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    nativeSymbol: "ETH",
  },
};

/** Cloudflare fronts several providers and 403s a bare client (`error code: 1010`). */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
export const HEADERS: Readonly<Record<string, string>> = { "User-Agent": UA, Accept: "application/json" };

/** A source that refuses this many calls in a row is refusing the RUN: a job stops, it does not spend its budget proving it. */
export const REFUSALS_IN_A_ROW = 5;
