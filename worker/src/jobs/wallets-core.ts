/**
 * Pure half of the funded-wallet linker (`jobs/wallets.ts`), twin of the constants and the
 * getTransaction parse in `scripts/link_wallets.mjs`. No I/O: tested in tests/wallets_job_test.ts.
 */

/** Below this a native transfer is rent or dust (an ATA costs ~0.00204 SOL), never funding. */
export const DUST_SOL = 0.003;
/** A first transfer of at least this much links on its own; smaller ones need a second touch. */
export const MIN_SOL = 0.05;

// ponytail: a seed list of programs and exchange hot wallets, lowercased to match
// transactions.counterparty. Extend as false links show up; a labels feed would replace it.
export const DENY: readonly string[] = [
  "11111111111111111111111111111111",              // system program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // token program
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // associated token program
  "ComputeBudget111111111111111111111111111111",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",   // jupiter v6
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",  // raydium amm v4
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",   // pump.fun
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",  // binance hot wallet
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",  // coinbase hot wallet
].map((a) => a.toLowerCase());

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((k): k is string => typeof k === "string");

/**
 * Every account key of a `getTransaction` (jsonParsed) response: static keys (objects with
 * `pubkey`, or bare strings on legacy encodings) plus the address-table lookups.
 */
export function accountKeys(res: unknown): string[] {
  const result = isRecord(res) && isRecord(res.result) ? res.result : null;
  const message = result && isRecord(result.transaction) && isRecord(result.transaction.message) ? result.transaction.message : null;
  const loaded = result && isRecord(result.meta) && isRecord(result.meta.loadedAddresses) ? result.meta.loadedAddresses : null;
  const statics = (Array.isArray(message?.accountKeys) ? message.accountKeys : [])
    .map((k: unknown) => (isRecord(k) ? k.pubkey : k));
  return [...strings(statics), ...strings(loaded?.writable), ...strings(loaded?.readonly)];
}

/** The case-preserved spelling of lowercased `key` among the response's accounts, or null. */
export function resolveCase(res: unknown, key: string): string | null {
  return accountKeys(res).find((k) => k.toLowerCase() === key) ?? null;
}
