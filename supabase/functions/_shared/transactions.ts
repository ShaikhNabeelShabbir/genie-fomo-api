// The only copy since 18 Sep 2026 (the scripts/ twin was deleted with the GitHub loaders).
// in as `ProviderKeys`, never read from the environment) and in typing third-party JSON as
// `unknown` narrowed by the helpers below instead of `any`.
import { EVM_CHAINS, HEADERS, type EvmChain } from "./settings.ts";
import { bitquery } from "./bitquery.ts";

/**
 * Live transaction fetching for a resolved wallet.
 *
 *   Robinhood  Blockscout   free, no key
 *   Ethereum   Etherscan    free tier covers chainid 1
 *   BSC/Base   Bitquery     Etherscan's free tier refuses both, and there is no free
 *                           alternative — no BSC Blockscout, the Base one 500s, public
 *                           RPCs need an archive token for historical logs
 *   Solana     Helius       Enhanced Transactions (legacy, but the free decoded source)
 *
 * Every chain reports its own status: `count: 0, error: null` means the wallet genuinely
 * has no activity there, while `count: 0, error: "..."` means we could not look.
 *
 * Two modes, because listing transfers and computing PnL want opposite things:
 *
 *   default        newest first, token transfers only — what /transactions has always done
 *   includeNative  adds native-currency movements and per-tx gas, and can page oldest-first
 *
 * The second exists because `tokentx` and Blockscout's `/token-transfers` are ERC-20 only.
 * An ETH -> memecoin buy therefore arrives with NO counter-leg, indistinguishable from an
 * airdrop, and with no fee attached. Without the native side, most EVM swaps cannot be
 * priced or paired at all.
 */

export interface Transfer {
  chain: string;
  tx_hash: string;
  time: number;
  time_iso: string | null;
  token: string;
  contract: string;
  amount: number | null;
  side: "in" | "out";
  from: string;
  to: string;
  explorer_url: string | null;
  type?: string;
  source?: string;
  /** Fee for the whole tx, in the chain's native token. Set on one row per tx_hash. */
  gas_native?: number;
}

export interface ChainStatus { readonly chain: string; readonly count: number; readonly error: string | null }

export interface FetchOptions {
  /** `asc` is required for a PnL replay: a sell can only be settled against earlier buys. */
  readonly order?: "asc" | "desc";
  /** Pull native-currency legs and gas alongside token transfers. */
  readonly includeNative?: boolean;
  /** Pages to walk per chain when the provider supports it. */
  readonly pages?: number;
}

/** Provider keys, trimmed by the caller. An empty or absent key makes that chain report an error. */
export interface ProviderKeys {
  readonly helius?: string;
  readonly etherscan?: string;
  readonly bitquery?: string;
}

export interface FetchResult {
  readonly transfers: Transfer[];
  readonly chains: ChainStatus[];
  readonly count: number;
  readonly elapsed_ms: number;
  readonly pulled_at: string;
}

// Narrowing for provider JSON: every field is read through one of these, never asserted.
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const big = (v: unknown): bigint => BigInt(v === undefined || v === null ? "0" : String(v));
/** `Number(x) || 0` as the source writes it: NaN becomes 0. */
const int = (v: unknown): number => Number(v) || 0;
const chainOf = (chainId: number): EvmChain => EVM_CHAINS[chainId];
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function row(
  wallet: string, chain: string, txHash: string, ts: number, token: string,
  contract: string, amount: number | null, from: string, to: string, explorer: string,
): Transfer {
  return {
    chain,
    tx_hash: txHash,
    time: ts,
    time_iso: ts ? new Date(ts * 1000).toISOString() : null,
    token,
    contract,
    amount,
    side: (to ?? "").toLowerCase() === wallet.toLowerCase() ? "in" : "out",
    from,
    to,
    explorer_url: txHash ? `${explorer}/tx/${txHash}` : null,
  };
}

const secs = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
};

/** Gas paid per tx, kept aside so a zero-value approve does not become a phantom trade. */
export type GasMap = Map<string, number>;

/** Blockscout's `next_page_params` as a query string, or "" when there is no next page. */
function nextParams(next: unknown, items: readonly unknown[]): string {
  if (!next || typeof next !== "object" || !items.length) return "";
  return "?" + new URLSearchParams(
    Object.entries(rec(next)).map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();
}

// ------------------------------------------------------------------ Robinhood

async function blockscoutTx(
  chainId: number, wallet: string, limit: number, pages: number,
): Promise<Transfer[]> {
  const cfg = chainOf(chainId);
  const out: Transfer[] = [];
  let params = "";
  for (let p = 0; p < pages && out.length < limit; p++) {
    const r = await fetch(
      `${cfg.blockscout}/api/v2/addresses/${wallet}/token-transfers${params}`,
      { headers: HEADERS, signal: AbortSignal.timeout(25_000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = rec(await r.json());
    const items = recs(d.items);
    for (const t of items) {
      const token = rec(t.token);
      const total = rec(t.total);
      let amount: number | null = null;
      try {
        const dec = Number(total.decimals ?? token.decimals ?? 0);
        amount = Number(big(total.value)) / 10 ** dec;
      } catch {
        amount = null;
      }
      out.push(row(
        wallet, cfg.name, str(t.tx_hash ?? t.transaction_hash), secs(str(t.timestamp)),
        str(token.symbol),
        // newer Blockscout names the contract address_hash
        str(token.address_hash ?? token.address),
        amount, str(rec(t.from).hash), str(rec(t.to).hash), cfg.explorer,
      ));
    }
    params = nextParams(d.next_page_params, items);
    if (!params) break;
  }
  return out.slice(0, limit);
}

/** Native-currency movements and gas, from Blockscout's plain transaction list. */
async function blockscoutNative(
  chainId: number, wallet: string, limit: number, pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  const cfg = chainOf(chainId);
  const rows: Transfer[] = [];
  const gas: GasMap = new Map();
  let params = "";
  let seen = 0;

  for (let p = 0; p < pages && seen < limit; p++) {
    const r = await fetch(
      `${cfg.blockscout}/api/v2/addresses/${wallet}/transactions${params}`,
      { headers: HEADERS, signal: AbortSignal.timeout(25_000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = rec(await r.json());
    const items = recs(d.items);
    for (const t of items) {
      seen++;
      const hash = str(t.hash);
      const from = str(rec(t.from).hash);
      const to = str(rec(t.to).hash);
      const ts = secs(str(t.timestamp));

      let value = 0;
      try { value = Number(big(t.value)) / 1e18; } catch { value = 0; }
      if (value > 0) {
        rows.push(row(wallet, cfg.name, hash, ts, cfg.nativeSymbol, "native",
          value, from, to, cfg.explorer));
      }
      // Only the sender pays for the block space.
      if (from.toLowerCase() === wallet.toLowerCase()) {
        try {
          const fee = Number(big(t.gas_used) * big(t.gas_price)) / 1e18;
          if (fee > 0) gas.set(hash, fee);
        } catch { /* fee fields absent on some Blockscout builds */ }
      }
    }
    params = nextParams(d.next_page_params, items);
    if (!params) break;
  }
  return { rows, gas };
}

// ------------------------------------------------------------------- Ethereum

async function etherscanCall(key: string, chainId: number, action: string, wallet: string,
  limit: number, order: "asc" | "desc", page: number): Promise<Rec[]> {
  const cfg = chainOf(chainId);
  if (!key) throw new Error("ETHERSCAN_KEY is not set");
  const url =
    `https://api.etherscan.io/v2/api?chainid=${cfg.etherscanChainId}` +
    `&module=account&action=${action}&address=${wallet}` +
    `&startblock=0&endblock=99999999&page=${page}&offset=${limit}&sort=${order}` +
    `&apikey=${key}`;
  const d = rec(await (await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })).json());
  // Etherscan reports plan/key problems inside `result`, with HTTP 200.
  if (typeof d.result === "string") {
    if (/no transactions found/i.test(d.result)) return [];
    throw new Error(d.result.slice(0, 160));
  }
  return recs(d.result);
}

async function etherscanTx(
  key: string, chainId: number, wallet: string, limit: number, order: "asc" | "desc", pages: number,
): Promise<Transfer[]> {
  // pages > 1 is opt-in; the plain transfer listing has always been a single call.
  const cfg = chainOf(chainId);
  const out: Transfer[] = [];
  const per = Math.min(limit, 1000);
  for (let p = 1; p <= pages && out.length < limit; p++) {
    const rows = await etherscanCall(key, chainId, "tokentx", wallet, per, order, p);
    for (const t of rows) {
      let amount: number | null = null;
      try {
        amount = Number(big(t.value)) / 10 ** Number(t.tokenDecimal ?? 0);
      } catch {
        amount = null;
      }
      out.push(row(wallet, cfg.name, str(t.hash), int(t.timeStamp), str(t.tokenSymbol),
        str(t.contractAddress), amount, str(t.from), str(t.to), cfg.explorer));
    }
    if (rows.length < per) break;
  }
  return out.slice(0, limit);
}

/** Native ETH/BNB legs and gas — the half of a swap that `tokentx` never returns. */
async function etherscanNative(
  key: string, chainId: number, wallet: string, limit: number, order: "asc" | "desc", pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  const cfg = chainOf(chainId);
  const rows: Transfer[] = [];
  const gas: GasMap = new Map();
  const per = Math.min(limit, 1000);

  for (let p = 1; p <= pages; p++) {
    const items = await etherscanCall(key, chainId, "txlist", wallet, per, order, p);
    for (const t of items) {
      const hash = str(t.hash);
      const from = str(t.from);
      const ts = int(t.timeStamp);

      // A reverted tx moves no value but still burns gas.
      const failed = str(t.isError ?? "0") === "1";
      let value = 0;
      try { value = Number(big(t.value)) / 1e18; } catch { value = 0; }
      if (value > 0 && !failed) {
        rows.push(row(wallet, cfg.name, hash, ts, cfg.nativeSymbol, "native",
          value, from, str(t.to), cfg.explorer));
      }
      if (from.toLowerCase() === wallet.toLowerCase()) {
        try {
          const fee = Number(big(t.gasUsed) * big(t.gasPrice)) / 1e18;
          if (fee > 0) gas.set(hash, fee);
        } catch { /* ignore malformed fee fields */ }
      }
    }
    if (items.length < per) break;
  }
  return { rows, gas };
}

// ------------------------------------------------------------------ BSC / Base

async function bitqueryTx(key: string, chainId: number, wallet: string, limit: number): Promise<Transfer[]> {
  const cfg = chainOf(chainId);
  const query = `{
    EVM(network: ${cfg.bitquery}, dataset: realtime) {
      Transfers(
        where: {any: [
          {Transfer: {Sender: {is: "${wallet}"}}}
          {Transfer: {Receiver: {is: "${wallet}"}}}
        ]}
        orderBy: {descending: Block_Time}
        limit: {count: ${Math.min(limit, 100)}}
      ) {
        Block { Time }
        Transaction { Hash }
        Transfer { Sender Receiver Amount Currency { Symbol SmartContract } }
      }
    }
  }`;
  const data = rec(await bitquery(key, query));
  return recs(rec(data.EVM).Transfers).map((t) => {
    const tr = rec(t.Transfer);
    const cur = rec(tr.Currency);
    const amount = Number(tr.Amount); // already scaled by decimals
    return row(wallet, cfg.name, str(rec(t.Transaction).Hash), secs(str(rec(t.Block).Time)),
      str(cur.Symbol), str(cur.SmartContract), Number.isFinite(amount) ? amount : null,
      str(tr.Sender), str(tr.Receiver), cfg.explorer);
  });
}

// --------------------------------------------------------------------- Solana

async function solanaTx(
  key: string, wallet: string, limit: number, includeNative: boolean, pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  if (!key) throw new Error("HELIUS_SOLANA_KEY is not set");

  // Helius caps a page at 100 and pages backwards with `before`. Depth matters more here
  // than anywhere else: a sell can only be settled if its buy is also in the pull, and an
  // active wallet burns through 100 signatures in a couple of days of airdrop spam alone.
  // Deep paging is only for the PnL replay. The plain listing stays a single call so it
  // keeps the latency and credit cost it always had.
  const maxPages = includeNative ? Math.max(1, pages) : 1;
  const txs: Rec[] = [];
  let before = "";
  for (let p = 0; p < maxPages; p++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${key}&limit=100${before ? `&before=${before}` : ""}`;
    const r = await fetch(url, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      if (txs.length) break; // keep what we already have rather than losing the whole pull
      throw new Error(
        r.status === 401 || r.status === 403 ? "Helius rejected the key" : `HTTP ${r.status}`,
      );
    }
    const data: unknown = await r.json();
    const page = Array.isArray(data) ? recs(data) : recs(rec(data).transactions);
    if (!page.length) break;
    txs.push(...page);
    before = str(page[page.length - 1].signature);
    if (!before || page.length < 100) break;
  }

  const out: Transfer[] = [];
  const gas: GasMap = new Map();

  for (const tx of txs) {
    const sig = str(tx.signature);
    const type = typeof tx.type === "string" ? tx.type : undefined;
    const source = typeof tx.source === "string" ? tx.source : undefined;
    for (const m of recs(tx.tokenTransfers)) {
      const from = str(m.fromUserAccount);
      const to = str(m.toUserAccount);
      if (from !== wallet && to !== wallet) continue;
      const mint = str(m.mint);
      const amount = Number(m.tokenAmount);
      const t = row(wallet, "solana", sig, int(tx.timestamp),
        mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "", mint,
        Number.isFinite(amount) ? amount : null, from, to, "https://solscan.io");
      t.type = type;
      t.source = source;
      out.push(t);
    }

    if (!includeNative) continue;

    // The SOL side of a swap, plus the signature fee. Both are needed before a
    // SOL -> token buy can be valued at all.
    for (const n of recs(tx.nativeTransfers)) {
      const from = str(n.fromUserAccount);
      const to = str(n.toUserAccount);
      if (from !== wallet && to !== wallet) continue;
      const lamports = Number(n.amount);
      if (!Number.isFinite(lamports) || lamports === 0) continue;
      const t = row(wallet, "solana", sig, int(tx.timestamp), "SOL", "native",
        lamports / 1e9, from, to, "https://solscan.io");
      t.type = type;
      t.source = source;
      out.push(t);
    }
    const fee = Number(tx.fee);
    if (Number.isFinite(fee) && fee > 0 && tx.feePayer === wallet) gas.set(sig, fee / 1e9);
  }
  return { rows: includeNative ? out : out.slice(0, limit), gas };
}

// ---------------------------------------------------------------- orchestration

interface ChainPull { readonly rows: Transfer[]; readonly gas: GasMap; readonly status: ChainStatus }

async function evmChain(
  keys: ProviderKeys, chainId: number, wallet: string, limit: number, opts: Required<FetchOptions>,
): Promise<ChainPull> {
  const cfg = chainOf(chainId);
  const gas: GasMap = new Map();
  try {
    let rows: Transfer[];
    if (cfg.name === "bsc" || cfg.name === "base") {
      rows = await bitqueryTx(keys.bitquery ?? "", chainId, wallet, limit);
    } else if (cfg.name === "robinhood" && cfg.blockscout) {
      rows = await blockscoutTx(chainId, wallet, limit, opts.pages);
      if (opts.includeNative) {
        const n = await blockscoutNative(chainId, wallet, limit, opts.pages);
        rows = rows.concat(n.rows);
        for (const [h, f] of n.gas) gas.set(h, f);
      }
    } else if (cfg.etherscanChainId) {
      const key = keys.etherscan ?? "";
      rows = await etherscanTx(key, chainId, wallet, limit, opts.order,
        opts.includeNative ? opts.pages : 1);
      if (opts.includeNative) {
        const n = await etherscanNative(key, chainId, wallet, limit, opts.order, opts.pages);
        rows = rows.concat(n.rows);
        for (const [h, f] of n.gas) gas.set(h, f);
      }
    } else {
      throw new Error("no transaction source configured");
    }
    return { rows, gas, status: { chain: cfg.name, count: rows.length, error: null } };
  } catch (e) {
    return { rows: [], gas, status: { chain: cfg.name, count: 0, error: message(e) } };
  }
}

export async function fetchTransactions(
  keys: ProviderKeys,
  evmWallet: string | null,
  solWallet: string | null,
  chains: readonly string[] | null,
  limit: number,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const opts: Required<FetchOptions> = {
    order: options.order ?? "desc",
    includeNative: options.includeNative ?? false,
    pages: Math.max(1, options.pages ?? 5),
  };

  const started = Date.now();
  const jobs: Promise<ChainPull>[] = [];

  if (evmWallet) {
    for (const [cid, cfg] of Object.entries(EVM_CHAINS)) {
      if (chains && !chains.includes(cfg.name)) continue;
      jobs.push(evmChain(keys, Number(cid), evmWallet, limit, opts));
    }
  }
  if (solWallet && (!chains || chains.includes("solana"))) {
    jobs.push(
      solanaTx(keys.helius ?? "", solWallet, limit, opts.includeNative, opts.pages)
        .then(({ rows, gas }): ChainPull => ({
          rows, gas, status: { chain: "solana", count: rows.length, error: null },
        }))
        .catch((e: unknown): ChainPull => ({
          rows: [], gas: new Map(), status: { chain: "solana", count: 0, error: message(e) },
        })),
    );
  }

  const settled = await Promise.all(jobs);
  const transfers = settled.flatMap((s) => s.rows);

  // Attach each tx's fee to exactly one of its rows, so summing per tx_hash cannot
  // double-count it.
  const gas: GasMap = new Map();
  for (const s of settled) for (const [h, f] of s.gas) gas.set(h, f);
  const feeApplied = new Set<string>();
  for (const t of transfers) {
    const fee = gas.get(t.tx_hash);
    if (fee !== undefined && !feeApplied.has(t.tx_hash)) {
      t.gas_native = fee;
      feeApplied.add(t.tx_hash);
    }
  }

  transfers.sort((a, b) => (opts.order === "asc" ? a.time - b.time : b.time - a.time));

  return {
    transfers,
    chains: settled.map((s) => s.status).sort((a, b) => a.chain.localeCompare(b.chain)),
    count: transfers.length,
    elapsed_ms: Date.now() - started,
    pulled_at: new Date().toISOString(),
  };
}
