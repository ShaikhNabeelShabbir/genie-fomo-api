/**
 * Chain constants for the Deno/Worker side. TWIN OF `scripts/lib/ts/settings.ts` (the loaders'
 * copy, which also reads .env and holds the Node-only paths): edit both when a chain changes.
 */
export { SOLANA_NETWORK_ID } from "./chain_reads.ts";

export interface EvmChain {
  readonly name: string;
  readonly bitquery: string;
  /** null where no usable instance exists — BSC has none, Base's returns 500s. */
  readonly blockscout: string | null;
  readonly rpc: string;
  readonly explorer: string;
  readonly etherscanChainId: number | null;
  /** Gas token — what a fee is denominated in, and the native leg of a swap. */
  readonly nativeSymbol: string;
}

export const EVM_CHAINS: Readonly<Record<number, EvmChain>> = {
  4663: {
    name: "robinhood",
    bitquery: "robinhood",
    blockscout: "https://robinhoodchain.blockscout.com",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    etherscanChainId: null,
    nativeSymbol: "ETH",
  },
  1: {
    name: "ethereum",
    bitquery: "eth",
    blockscout: "https://eth.blockscout.com",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    etherscanChainId: 1,
    nativeSymbol: "ETH",
  },
  56: {
    name: "bsc",
    bitquery: "bsc",
    blockscout: null,
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
    etherscanChainId: 56,
    nativeSymbol: "BNB",
  },
  8453: {
    name: "base",
    bitquery: "base",
    blockscout: null,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    etherscanChainId: 8453,
    nativeSymbol: "ETH",
  },
};
