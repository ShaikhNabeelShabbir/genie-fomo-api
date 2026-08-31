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
};

export type ChainStatus = { chain: string; count: number; error: string | null };

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

// ------------------------------------------------------------------ Robinhood

async function blockscoutTx(chainId: number, wallet: string, limit: number): Promise<Transfer[]> {
  const cfg = EVM_CHAINS[chainId];
  const out: Transfer[] = [];
  let params = "";
  for (let p = 0; p < 5 && out.length < limit; p++) {
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

// ------------------------------------------------------------------- Ethereum

async function etherscanTx(chainId: number, wallet: string, limit: number): Promise<Transfer[]> {
  const cfg = EVM_CHAINS[chainId];
  if (!haveEtherscan()) throw new Error("ETHERSCAN_KEY is not set");
  const url =
    `https://api.etherscan.io/v2/api?chainid=${cfg.etherscanChainId}` +
    `&module=account&action=tokentx&address=${wallet}` +
    `&startblock=0&endblock=99999999&page=1&offset=${limit}&sort=desc&apikey=${ETHERSCAN_KEY}`;
  const d: any = await (await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })).json();
  // Etherscan reports plan/key problems inside `result`, with HTTP 200.
  if (typeof d?.result === "string") {
    if (/no transactions found/i.test(d.result)) return [];
    throw new Error(String(d.result).slice(0, 160));
  }
  return (d?.result ?? []).map((t: any) => {
    let amount: number | null = null;
    try {
      amount = Number(BigInt(t.value ?? "0")) / 10 ** Number(t.tokenDecimal ?? 0);
    } catch {
      amount = null;
    }
    return row(wallet, cfg.name, t.hash, Number(t.timeStamp) || 0, t.tokenSymbol ?? "",
      t.contractAddress ?? "", amount, t.from ?? "", t.to ?? "", cfg.explorer);
  });
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

async function solanaTx(wallet: string, limit: number): Promise<Transfer[]> {
  if (!haveHelius()) throw new Error("HELIUS_SOLANA_KEY is not set");
  const url =
    `https://api.helius.xyz/v0/addresses/${wallet}/transactions` +
    `?api-key=${HELIUS_KEY}&limit=${Math.min(limit, 100)}`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) {
    throw new Error(
      r.status === 401 || r.status === 403 ? "Helius rejected the key" : `HTTP ${r.status}`,
    );
  }
  const data: any = await r.json();
  const txs: any[] = Array.isArray(data) ? data : (data?.transactions ?? []);
  const out: Transfer[] = [];
  for (const tx of txs) {
    for (const m of tx.tokenTransfers ?? []) {
      const from = m.fromUserAccount ?? "";
      const to = m.toUserAccount ?? "";
      if (from !== wallet && to !== wallet) continue;
      const mint: string = m.mint ?? "";
      const amount = Number(m.tokenAmount);
      const t = row(wallet, "solana", tx.signature ?? "", Number(tx.timestamp) || 0,
        mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "", mint,
        Number.isFinite(amount) ? amount : null, from, to, "https://solscan.io");
      t.type = tx.type;
      t.source = tx.source;
      out.push(t);
    }
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------- orchestration

async function evmChain(
  chainId: number, wallet: string, limit: number,
): Promise<{ rows: Transfer[]; status: ChainStatus }> {
  const cfg = EVM_CHAINS[chainId];
  try {
    let rows: Transfer[];
    if (cfg.name === "bsc" || cfg.name === "base") rows = await bitqueryTx(chainId, wallet, limit);
    else if (cfg.name === "robinhood" && cfg.blockscout) rows = await blockscoutTx(chainId, wallet, limit);
    else if (cfg.etherscanChainId) rows = await etherscanTx(chainId, wallet, limit);
    else throw new Error("no transaction source configured");
    return { rows, status: { chain: cfg.name, count: rows.length, error: null } };
  } catch (e) {
    return {
      rows: [],
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
) {
  const started = Date.now();
  const jobs: Promise<{ rows: Transfer[]; status: ChainStatus }>[] = [];

  if (evmWallet) {
    for (const [cid, cfg] of Object.entries(EVM_CHAINS)) {
      if (chains && !chains.includes(cfg.name)) continue;
      jobs.push(evmChain(Number(cid), evmWallet, limit));
    }
  }
  if (solWallet && (!chains || chains.includes("solana"))) {
    jobs.push(
      solanaTx(solWallet, limit)
        .then((rows) => ({ rows, status: { chain: "solana", count: rows.length, error: null } }))
        .catch((e) => ({
          rows: [] as Transfer[],
          status: {
            chain: "solana",
            count: 0,
            error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
          },
        })),
    );
  }

  const settled = await Promise.all(jobs);
  const transfers = settled.flatMap((s) => s.rows).sort((a, b) => b.time - a.time);
  return {
    transfers,
    chains: settled.map((s) => s.status).sort((a, b) => a.chain.localeCompare(b.chain)),
    count: transfers.length,
    elapsed_ms: Date.now() - started,
    pulled_at: new Date().toISOString(),
  };
}
