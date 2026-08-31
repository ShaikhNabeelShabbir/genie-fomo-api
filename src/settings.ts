import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This package is standalone: everything it needs lives inside PKG_ROOT. The parent
 * directory is only consulted as a fallback, so it still works when checked out inside
 * the genie-fomo monorepo.
 */
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Package root — one level up from src/, or two from dist/src when built. */
export const PKG_ROOT = fs.existsSync(path.join(SRC_DIR, "..", "package.json"))
  ? path.resolve(SRC_DIR, "..")
  : path.resolve(SRC_DIR, "../..");

/** Node does not read .env on its own — load it before anything reads process.env. */
function loadDotenv(): void {
  const candidates = [
    path.join(PKG_ROOT, ".env"),          // standalone checkout
    path.join(PKG_ROOT, "..", ".env"),    // inside the genie-fomo monorepo
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const i = t.indexOf("=");
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}
loadDotenv();

/**
 * The trader directory: the output of build_directory.py — handles, holdings, and the
 * addresses fomo publishes. Any resolution fields in it are ignored; this service
 * resolves live so responses reflect the chain now, not a snapshot.
 *
 * Ships with a copy in ./data so the service runs out of the box. Point WALLETS_FILE
 * at a fresher one to update.
 */
function defaultWalletsFile(): string {
  const local = path.join(PKG_ROOT, "data", "wallet.full.data.json");
  if (fs.existsSync(local)) return local;
  return path.join(PKG_ROOT, "..", "data", "wallet.full.data.json");
}

export const WALLETS_FILE = process.env.WALLETS_FILE ?? defaultWalletsFile();

export const ETHERSCAN_KEY = (process.env.ETHERSCAN_KEY ?? "").trim();
export const BITQUERY_KEY = (process.env.BITQUERY_KEY ?? "").trim();
export const HELIUS_KEY = (process.env.HELIUS_SOLANA_KEY ?? process.env.HELIUS_KEY ?? "").trim();
/** When set, requests must send X-API-Key. Unset means open, for local development. */
export const API_KEY = (process.env.GENIE_API_KEY ?? "").trim();
export const PORT = Number(process.env.PORT ?? 8787);
/** Comma-separated allowed origins. Empty means allow any — fine locally, but set it
 *  in production so a browser on another site cannot spend your provider quota. */
export const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);

export const SOLANA_NETWORK_ID = 1399811149;

export type EvmChain = {
  name: string;
  bitquery: string;
  /** null where no usable instance exists — BSC has none, Base's returns 500s. */
  blockscout: string | null;
  rpc: string;
  explorer: string;
  etherscanChainId: number | null;
};

export const EVM_CHAINS: Record<number, EvmChain> = {
  4663: {
    name: "robinhood",
    bitquery: "robinhood",
    blockscout: "https://robinhoodchain.blockscout.com",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    etherscanChainId: null,
  },
  1: {
    name: "ethereum",
    bitquery: "eth",
    blockscout: "https://eth.blockscout.com",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    etherscanChainId: 1,
  },
  56: {
    name: "bsc",
    bitquery: "bsc",
    blockscout: null,
    rpc: "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
    etherscanChainId: 56,
  },
  8453: {
    name: "base",
    bitquery: "base",
    blockscout: null,
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    etherscanChainId: 8453,
  },
};

export const haveBitquery = () => !!BITQUERY_KEY;
export const haveHelius = () => !!HELIUS_KEY;
export const haveEtherscan = () => !!ETHERSCAN_KEY;

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
export const HEADERS = { "User-Agent": UA, Accept: "application/json" };
