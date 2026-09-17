/** Reading true balances off the five chains we carry — the Deno half. See docs/DECISIONS.md#d001 */

export const SOLANA_NETWORK_ID = 1399811149;
/** Native SOL under the key quote_assets already uses, so it prices like any other quote. */
export const SOL_MINT = "11111111111111111111111111111111";
/** Native ETH/BNB under the EVM sentinel, seeded in tokens + quote_assets (N1). */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // Token-2022; a mint here is invisible to the other
];
const BAL_SELECTOR = "0x70a08231";  // balanceOf(address)
const DEC_SELECTOR = "0x313ce567";  // decimals()
/** 40 keeps us inside the batch cap every public RPC we use accepts. */
const BATCH = 40;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One in-flight request per host, with a floor on the gap between them. See docs/DECISIONS.md#d002 */
const HOST_GAP_MS = 260;
const hostQueue = new Map<string, Promise<unknown>>();
export function throttled<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  const prev = hostQueue.get(host) ?? Promise.resolve();
  const next = prev.then(async () => {
    const t = Date.now();
    try { return await fn(); } finally { await sleep(Math.max(0, HOST_GAP_MS - (Date.now() - t))); }
  });
  hostQueue.set(host, next.catch(() => {}));
  return next as Promise<T>;
}

// deno-lint-ignore no-explicit-any
export async function rpc(url: string, body: unknown, tries = 5): Promise<any> {
  for (let i = 1; ; i++) {
    try {
      return await throttled(url, async () => {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(45_000),
        });
        /*
         * robinhood's RPC sits behind the same Cloudflare that 403s its explorer, and answers
         * 403 rather than 429 when it wants us to slow down. Backing off on both costs one
         * wasted wait on a genuine refusal and saves a whole chain's leg.
         */
        if (r.status === 429 || r.status === 403) {
          const ra = Number(r.headers.get("retry-after"));
          const e = new Error("HTTP 429") as Error & { waitMs?: number | null };
          e.waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : null;
          throw e;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      });
    } catch (e) {
      if (i >= tries) throw e;
      await sleep((e as { waitMs?: number | null }).waitMs ?? Math.min(800 * 2 ** (i - 1), 12_000));
    }
  }
}

/** A uint256 hex word. Returns null for "0x" / reverted, which is NOT a zero balance. */
export function word(hex: unknown): bigint | null {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/i.test(hex) || hex.length < 3) return null;
  try { return BigInt(hex); } catch { return null; }
}

/** BigInt -> decimal string, exact. Number() would round anything past 2^53. */
export function scale(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

// --------------------------------------------------------------------- solana
export async function solanaBalances(
  address: string, heliusKey: string,
): Promise<{ address: string; amount: string }[] | null> {
  if (!heliusKey) return null;
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const out: { address: string; amount: string }[] = [];

  for (const programId of TOKEN_PROGRAMS) {
    const j = await rpc(url, {
      jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
      params: [address, { programId }, { encoding: "jsonParsed" }],
    });
    if (j.error) throw new Error(String(j.error?.message ?? "rpc error").slice(0, 80));
    for (const acc of j.result?.value ?? []) {
      const info = acc.account?.data?.parsed?.info;
      const amt = info?.tokenAmount?.uiAmountString;
      // One owner can hold the same mint in several token accounts; sum, never overwrite.
      if (!info?.mint || !amt || Number(amt) <= 0) continue;
      const hit = out.find((o) => o.address === info.mint);
      if (hit) hit.amount = String(Number(hit.amount) + Number(amt));
      else out.push({ address: info.mint, amount: amt });
    }
  }

  const nat = await rpc(url, { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] });
  const lamports = nat.result?.value;
  if (typeof lamports === "number" && lamports > 0) {
    out.push({ address: SOL_MINT, amount: scale(BigInt(lamports), 9) });
  }
  return out;
}

// ------------------------------------------------------------------------ evm
/**
 * Balances for the tokens this wallet has traded on one chain.
 *
 * Scoped to traded tokens on purpose: an EVM chain has no cheap "list everything this address
 * holds" primitive without a paid indexer, and a token they never traded is one we could not
 * price or name anyway. It is the honest superset of their positions here.
 *
 * LEGACY: the Supabase v1 sampler only. The Worker reads EVM through `bitquery.ts`
 * `evmBalancesBitquery` (public RPCs 429 Cloudflare's egress); nothing under worker/ may call this.
 */
export async function evmBalances(
  rpcUrl: string,
  wallet: string,
  tokens: { token_key: string; address: string }[],
  decimalsByKey: { get(k: string): number | undefined | null; set(k: string, v: number): void },
): Promise<{ balances: { address: string; amount: string }[]; learned: Map<string, number> }> {
  const padded = wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = BAL_SELECTOR + padded;
  const out: { address: string; amount: string }[] = [];

  const need = tokens.filter((t) => decimalsByKey.get(t.token_key) == null);
  const learned = new Map<string, number>();
  for (let i = 0; i < need.length; i += BATCH) {
    const slice = need.slice(i, i + BATCH);
    const j = await rpc(rpcUrl, slice.map((t, k) => ({
      jsonrpc: "2.0", id: k, method: "eth_call",
      params: [{ to: t.address, data: DEC_SELECTOR }, "latest"],
    })));
    for (const r of Array.isArray(j) ? j : []) {
      /*
       * JSON-RPC lets a batch reply carry an id we never sent -- null on a parse error, and
       * some nodes renumber. Indexing blind on it threw mid-run and cost five traders their
       * whole BSC leg, so an id that is not one of ours is skipped, not trusted.
       */
      const t = slice[r?.id];
      if (!t) continue;
      const d = word(r?.result);
      // A token whose decimals() reverts is not an ERC-20 we can read a balance from.
      if (d !== null && d <= 36n) learned.set(t.token_key, Number(d));
    }
  }
  for (const [k, v] of learned) decimalsByKey.set(k, v);

  for (let i = 0; i < tokens.length; i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    const j = await rpc(rpcUrl, slice.map((t, k) => ({
      jsonrpc: "2.0", id: k, method: "eth_call",
      params: [{ to: t.address, data }, "latest"],
    })));
    for (const r of Array.isArray(j) ? j : []) {
      const t = slice[r?.id];
      if (!t) continue;
      const raw = word(r?.result);
      const dec = decimalsByKey.get(t.token_key);
      /*
       * A zero balance is not a holding, and a null one is "we could not read it" -- neither
       * becomes a row, and neither becomes a 0 in the portfolio.
       */
      if (raw === null || raw === 0n || dec == null) continue;
      out.push({ address: t.address, amount: scale(raw, dec) });
    }
  }
  // The chain's own coin: one eth_getBalance per wallet, pushed under the sentinel (N1).
  const nat = await rpc(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [wallet, "latest"] });
  const wei = word(nat?.result);
  if (wei !== null && wei > 0n) out.push({ address: ZERO_ADDRESS, amount: scale(wei, 18) });
  return { balances: out, learned };
}

/**
 * The wallet's outgoing-transaction count (its nonce): what the chain says he did, to set
 * against the rows the indexer holds (R6). Null when the node will not say; never a 0 by default.
 */
export async function evmTxCount(rpcUrl: string, wallet: string): Promise<number | null> {
  try {
    const j = await rpc(rpcUrl, { jsonrpc: "2.0", id: 1, method: "eth_getTransactionCount", params: [wallet, "latest"] });
    const w = word(j?.result);
    return w === null ? null : Number(w);
  } catch {
    return null;
  }
}
