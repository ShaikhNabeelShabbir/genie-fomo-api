import {
  BITQUERY_KEY,
  ETHERSCAN_KEY,
  EVM_CHAINS,
  HEADERS,
  HELIUS_KEY,
  haveBitquery,
  haveEtherscan,
  haveHelius,
} from "./settings.js";

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

export type Transfer = {
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
};

export type ChainStatus = { chain: string; count: number; error: string | null };

export type FetchOptions = {
  /** `asc` is required for a PnL replay: a sell can only be settled against earlier buys. */
  order?: "asc" | "desc";
  /** Pull native-currency legs and gas alongside token transfers. */
  includeNative?: boolean;
  /** Pages to walk per chain when the provider supports it. */
  pages?: number;
};

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

// ------------------------------------------------------------------ Robinhood

async function blockscoutTx(
  chainId: number, wallet: string, limit: number, pages: number,
): Promise<Transfer[]> {
  const cfg = EVM_CHAINS[chainId];
  const out: Transfer[] = [];
  let params = "";
  for (let p = 0; p < pages && out.length < limit; p++) {
    const r = await fetch(
      `${cfg.blockscout}/api/v2/addresses/${wallet}/token-transfers${params}`,
      { headers: HEADERS, signal: AbortSignal.timeout(25_000) },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d: any = await r.json();
    const items: any[] = d?.items ?? [];
    for (const t of items) {
      const token = t.token ?? {};
      const total = t.total ?? {};
      let amount: number | null = null;
      try {
        const dec = Number(total.decimals ?? token.decimals ?? 0);
        amount = Number(BigInt(total.value ?? "0")) / 10 ** dec;
      } catch {
        amount = null;
      }
      out.push(row(
        wallet, cfg.name, t.tx_hash ?? t.transaction_hash ?? "", secs(String(t.timestamp ?? "")),
        token.symbol ?? "",
        // newer Blockscout names the contract address_hash
        token.address_hash ?? token.address ?? "",
        amount, t.from?.hash ?? "", t.to?.hash ?? "", cfg.explorer,
      ));
    }
    const next = d?.next_page_params;
    if (!next || !items.length) break;
    params = "?" + new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
  }
  return out.slice(0, limit);
}

/** Native-currency movements and gas, from Blockscout's plain transaction list. */
async function blockscoutNative(
  chainId: number, wallet: string, limit: number, pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  const cfg = EVM_CHAINS[chainId];
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
    const d: any = await r.json();
    const items: any[] = d?.items ?? [];
    for (const t of items) {
      seen++;
      const hash = t.hash ?? "";
      const from = t.from?.hash ?? "";
      const to = t.to?.hash ?? "";
      const ts = secs(String(t.timestamp ?? ""));

      let value = 0;
      try { value = Number(BigInt(t.value ?? "0")) / 1e18; } catch { value = 0; }
      if (value > 0) {
        rows.push(row(wallet, cfg.name, hash, ts, cfg.nativeSymbol, "native",
          value, from, to, cfg.explorer));
      }
      // Only the sender pays for the block space.
      if (from.toLowerCase() === wallet.toLowerCase()) {
        try {
          const fee = Number(BigInt(t.gas_used ?? "0") * BigInt(t.gas_price ?? "0")) / 1e18;
          if (fee > 0) gas.set(hash, fee);
        } catch { /* fee fields absent on some Blockscout builds */ }
      }
    }
    const next = d?.next_page_params;
    if (!next || !items.length) break;
    params = "?" + new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
  }
  return { rows, gas };
}

// ------------------------------------------------------------------- Ethereum

async function etherscanCall(chainId: number, action: string, wallet: string,
  limit: number, order: "asc" | "desc", page: number): Promise<any[]> {
  const cfg = EVM_CHAINS[chainId];
  if (!haveEtherscan()) throw new Error("ETHERSCAN_KEY is not set");
  const url =
    `https://api.etherscan.io/v2/api?chainid=${cfg.etherscanChainId}` +
    `&module=account&action=${action}&address=${wallet}` +
    `&startblock=0&endblock=99999999&page=${page}&offset=${limit}&sort=${order}` +
    `&apikey=${ETHERSCAN_KEY}`;
  const d: any = await (await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })).json();
  // Etherscan reports plan/key problems inside `result`, with HTTP 200.
  if (typeof d?.result === "string") {
    if (/no transactions found/i.test(d.result)) return [];
    throw new Error(String(d.result).slice(0, 160));
  }
  return d?.result ?? [];
}

async function etherscanTx(
  chainId: number, wallet: string, limit: number, order: "asc" | "desc", pages: number,
): Promise<Transfer[]> {
  // pages > 1 is opt-in; the plain transfer listing has always been a single call.
  const cfg = EVM_CHAINS[chainId];
  const out: Transfer[] = [];
  const per = Math.min(limit, 1000);
  for (let p = 1; p <= pages && out.length < limit; p++) {
    const rows = await etherscanCall(chainId, "tokentx", wallet, per, order, p);
    for (const t of rows) {
      let amount: number | null = null;
      try {
        amount = Number(BigInt(t.value ?? "0")) / 10 ** Number(t.tokenDecimal ?? 0);
      } catch {
        amount = null;
      }
      out.push(row(wallet, cfg.name, t.hash, Number(t.timeStamp) || 0, t.tokenSymbol ?? "",
        t.contractAddress ?? "", amount, t.from ?? "", t.to ?? "", cfg.explorer));
    }
    if (rows.length < per) break;
  }
  return out.slice(0, limit);
}

/** Native ETH/BNB legs and gas — the half of a swap that `tokentx` never returns. */
async function etherscanNative(
  chainId: number, wallet: string, limit: number, order: "asc" | "desc", pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  const cfg = EVM_CHAINS[chainId];
  const rows: Transfer[] = [];
  const gas: GasMap = new Map();
  const per = Math.min(limit, 1000);

  for (let p = 1; p <= pages; p++) {
    const items = await etherscanCall(chainId, "txlist", wallet, per, order, p);
    for (const t of items) {
      const hash = String(t.hash ?? "");
      const from = String(t.from ?? "");
      const ts = Number(t.timeStamp) || 0;

      // A reverted tx moves no value but still burns gas.
      const failed = String(t.isError ?? "0") === "1";
      let value = 0;
      try { value = Number(BigInt(t.value ?? "0")) / 1e18; } catch { value = 0; }
      if (value > 0 && !failed) {
        rows.push(row(wallet, cfg.name, hash, ts, cfg.nativeSymbol, "native",
          value, from, String(t.to ?? ""), cfg.explorer));
      }
      if (from.toLowerCase() === wallet.toLowerCase()) {
        try {
          const fee = Number(BigInt(t.gasUsed ?? "0") * BigInt(t.gasPrice ?? "0")) / 1e18;
          if (fee > 0) gas.set(hash, fee);
        } catch { /* ignore malformed fee fields */ }
      }
    }
    if (items.length < per) break;
  }
  return { rows, gas };
}

// ------------------------------------------------------------------ BSC / Base

async function bitqueryTx(chainId: number, wallet: string, limit: number): Promise<Transfer[]> {
  const cfg = EVM_CHAINS[chainId];
  if (!haveBitquery()) throw new Error("BITQUERY_KEY is not set");
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
  const r = await fetch("https://streaming.bitquery.io/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BITQUERY_KEY}` },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(45_000),
  });
  const j: any = await r.json();
  if (j?.errors) {
    const msg = String(j.errors[0]?.message ?? "");
    throw new Error(/points limit|quota/i.test(msg) ? "Bitquery quota reached" : msg.slice(0, 160));
  }
  return (j?.data?.EVM?.Transfers ?? []).map((t: any) => {
    const tr = t.Transfer ?? {};
    const cur = tr.Currency ?? {};
    const amount = Number(tr.Amount); // already scaled by decimals
    return row(wallet, cfg.name, t.Transaction?.Hash ?? "", secs(String(t.Block?.Time ?? "")),
      cur.Symbol ?? "", cur.SmartContract ?? "", Number.isFinite(amount) ? amount : null,
      tr.Sender ?? "", tr.Receiver ?? "", cfg.explorer);
  });
}

// --------------------------------------------------------------------- Solana

async function solanaTx(
  wallet: string, limit: number, includeNative: boolean, pages: number,
): Promise<{ rows: Transfer[]; gas: GasMap }> {
  if (!haveHelius()) throw new Error("HELIUS_SOLANA_KEY is not set");

  // Helius caps a page at 100 and pages backwards with `before`. Depth matters more here
  // than anywhere else: a sell can only be settled if its buy is also in the pull, and an
  // active wallet burns through 100 signatures in a couple of days of airdrop spam alone.
  // Deep paging is only for the PnL replay. The plain listing stays a single call so it
  // keeps the latency and credit cost it always had.
  const maxPages = includeNative ? Math.max(1, pages) : 1;
  const txs: any[] = [];
  let before = "";
  for (let p = 0; p < maxPages; p++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
      `?api-key=${HELIUS_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    const r = await fetch(url, {
      headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      if (txs.length) break; // keep what we already have rather than losing the whole pull
      throw new Error(
        r.status === 401 || r.status === 403 ? "Helius rejected the key" : `HTTP ${r.status}`,
      );
    }
    const data: any = await r.json();
    const page: any[] = Array.isArray(data) ? data : (data?.transactions ?? []);
    if (!page.length) break;
    txs.push(...page);
    before = page[page.length - 1]?.signature ?? "";
    if (!before || page.length < 100) break;
  }

  const out: Transfer[] = [];
  const gas: GasMap = new Map();

  for (const tx of txs) {
    const sig: string = tx.signature ?? "";
    for (const m of tx.tokenTransfers ?? []) {
      const from = m.fromUserAccount ?? "";
      const to = m.toUserAccount ?? "";
      if (from !== wallet && to !== wallet) continue;
      const mint: string = m.mint ?? "";
      const amount = Number(m.tokenAmount);
      const t = row(wallet, "solana", sig, Number(tx.timestamp) || 0,
        mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "", mint,
        Number.isFinite(amount) ? amount : null, from, to, "https://solscan.io");
      t.type = tx.type;
      t.source = tx.source;
      out.push(t);
    }

    if (!includeNative) continue;

    // The SOL side of a swap, plus the signature fee. Both are needed before a
    // SOL -> token buy can be valued at all.
    for (const n of tx.nativeTransfers ?? []) {
      const from = n.fromUserAccount ?? "";
      const to = n.toUserAccount ?? "";
      if (from !== wallet && to !== wallet) continue;
      const lamports = Number(n.amount);
      if (!Number.isFinite(lamports) || lamports === 0) continue;
      const t = row(wallet, "solana", sig, Number(tx.timestamp) || 0, "SOL", "native",
        lamports / 1e9, from, to, "https://solscan.io");
      t.type = tx.type;
      t.source = tx.source;
      out.push(t);
    }
    const fee = Number(tx.fee);
    if (Number.isFinite(fee) && fee > 0 && tx.feePayer === wallet) gas.set(sig, fee / 1e9);
  }
  return { rows: includeNative ? out : out.slice(0, limit), gas };
}

// ---------------------------------------------------------------- orchestration

async function evmChain(
  chainId: number, wallet: string, limit: number, opts: Required<FetchOptions>,
): Promise<{ rows: Transfer[]; gas: GasMap; status: ChainStatus }> {
  const cfg = EVM_CHAINS[chainId];
  const gas: GasMap = new Map();
  try {
    let rows: Transfer[];
    if (cfg.name === "bsc" || cfg.name === "base") {
      rows = await bitqueryTx(chainId, wallet, limit);
    } else if (cfg.name === "robinhood" && cfg.blockscout) {
      rows = await blockscoutTx(chainId, wallet, limit, opts.pages);
      if (opts.includeNative) {
        const n = await blockscoutNative(chainId, wallet, limit, opts.pages);
        rows = rows.concat(n.rows);
        for (const [h, f] of n.gas) gas.set(h, f);
      }
    } else if (cfg.etherscanChainId) {
      rows = await etherscanTx(chainId, wallet, limit, opts.order,
        opts.includeNative ? opts.pages : 1);
      if (opts.includeNative) {
        const n = await etherscanNative(chainId, wallet, limit, opts.order, opts.pages);
        rows = rows.concat(n.rows);
        for (const [h, f] of n.gas) gas.set(h, f);
      }
    } else {
      throw new Error("no transaction source configured");
    }
    return { rows, gas, status: { chain: cfg.name, count: rows.length, error: null } };
  } catch (e) {
    return {
      rows: [],
      gas,
      status: {
        chain: cfg.name,
        count: 0,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
      },
    };
  }
}

export async function fetchTransactions(
  evmWallet: string | null,
  solWallet: string | null,
  chains: string[] | null,
  limit: number,
  options: FetchOptions = {},
) {
  const opts: Required<FetchOptions> = {
    order: options.order ?? "desc",
    includeNative: options.includeNative ?? false,
    pages: Math.max(1, options.pages ?? 5),
  };

  const started = Date.now();
  const jobs: Promise<{ rows: Transfer[]; gas: GasMap; status: ChainStatus }>[] = [];

  if (evmWallet) {
    for (const [cid, cfg] of Object.entries(EVM_CHAINS)) {
      if (chains && !chains.includes(cfg.name)) continue;
      jobs.push(evmChain(Number(cid), evmWallet, limit, opts));
    }
  }
  if (solWallet && (!chains || chains.includes("solana"))) {
    jobs.push(
      solanaTx(solWallet, limit, opts.includeNative, opts.pages)
        .then(({ rows, gas }) => ({
          rows, gas, status: { chain: "solana", count: rows.length, error: null },
        }))
        .catch((e) => ({
          rows: [] as Transfer[],
          gas: new Map() as GasMap,
          status: {
            chain: "solana",
            count: 0,
            error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          },
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
