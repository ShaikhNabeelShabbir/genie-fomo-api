import {
  BITQUERY_KEY,
  EVM_CHAINS,
  HEADERS,
  HELIUS_KEY,
  SOLANA_NETWORK_ID,
  haveBitquery,
  haveHelius,
} from "./settings.js";
import type { Holding, Trader } from "./directory.js";

/**
 * Live wallet resolution — the core of the API.
 *
 * fomo's `evmAddress` / `address` are provisioned wallets that hold none of the trader's
 * positions. What fomo does give us is the exact size of each position, and that is a
 * fingerprint: ask the chain who holds that amount of that token and you get the wallet
 * the trading actually happens from.
 *
 * EVM, in order of preference:
 *   1. Bitquery   — filters holders by balance range server-side, so position size is
 *                   irrelevant and all four chains are covered.
 *   2. Blockscout — free and keyless, but only pages the top ~100 holders, so it finds
 *                   whales and misses small positions. Robinhood and Ethereum only.
 *
 * Solana uses Helius; the public RPC refuses getTokenLargestAccounts outright.
 */

// Narrow first, widen only if nothing lands. The leaderboard is a snapshot, so an active
// trader's balance drifts — observed 0.005% on one position, 9.3% on another.
const BANDS = [0.002, 0.02, 0.15];
const TOLERANCE = 0.15;

// These wallets are EIP-7702 delegated EOAs and report is_contract=true, so never filter
// on that — it discards the correct answer. Exclude infrastructure by its label instead.
const INFRA_WORDS = ["pool", "router", "locker", "bridge", "vault", "factory", "manager",
  "staking", "farm", "treasury", "multicall", "swap", "dex"];
const BURN = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

export type Match = {
  chain: string;
  token: string;
  reported: number;
  onchain: number;
  off_by: number;
  via: string;
};

export type Resolution = {
  address: string | null;
  confidence: string;
  matches: Match[];
  best_off_by?: number;
  method?: string | null;
  candidates_considered?: number;
  notes: string[];
};

const decimalsCache = new Map<string, number>();

async function rpc(chainId: number, method: string, params: unknown[]): Promise<any> {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg) return null;
  try {
    const r = await fetch(cfg.rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json()) as { result?: unknown };
    return j?.result ?? null;
  } catch {
    return null;
  }
}

async function decimals(chainId: number, contract: string): Promise<number> {
  const key = `${chainId}:${contract.toLowerCase()}`;
  const hit = decimalsCache.get(key);
  if (hit !== undefined) return hit;
  const res = await rpc(chainId, "eth_call", [{ to: contract, data: "0x313ce567" }, "latest"]);
  const d = res ? Number.parseInt(String(res), 16) : NaN;
  const out = Number.isFinite(d) ? d : 18;
  decimalsCache.set(key, out);
  return out;
}

/** Confirm a candidate on any chain — needs no holder list, so BSC works too. */
export async function balanceOf(
  chainId: number,
  contract: string,
  wallet: string,
): Promise<number | null> {
  const data = "0x70a08231" + wallet.slice(2).toLowerCase().padStart(64, "0");
  const res = await rpc(chainId, "eth_call", [{ to: contract, data }, "latest"]);
  if (!res) return null;
  try {
    return Number(BigInt(res)) / 10 ** (await decimals(chainId, contract));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ EVM: Bitquery

async function bitqueryHolders(
  network: string,
  contract: string,
  lo: number,
  hi: number,
): Promise<[string, number][]> {
  const query = `{
    EVM(network: ${network}, dataset: realtime) {
      Holders(
        where: {
          Currency: {SmartContract: {is: "${contract}"}}
          Balance: {Amount: {ge: "${lo.toFixed(6)}", le: "${hi.toFixed(6)}"}}
        }
        orderBy: {descending: Balance_Amount}
        limit: {count: 30}
      ) { Holder { Address } Balance { Amount } }
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
    const msg = String(j.errors[0]?.message ?? "bitquery error");
    throw new Error(/points limit|quota/i.test(msg) ? "Bitquery quota reached" : msg.slice(0, 160));
  }
  return (j?.data?.EVM?.Holders ?? []).map(
    (h: any) => [h.Holder.Address, Number(h.Balance.Amount)] as [string, number],
  );
}

// ---------------------------------------------------------------- EVM: Blockscout

/** Blockscout sits behind Cloudflare and starts returning 403 challenge pages under
 *  load. Retry briefly, then report the real status — a silent empty list would look
 *  like "this token has no holders", which is a different and wrong answer. */
async function blockscoutHolders(
  host: string,
  chainId: number,
  contract: string,
  pages = 2,
): Promise<{ rows: [string, number][]; error: string | null }> {
  const dec = await decimals(chainId, contract);
  const out: [string, number][] = [];
  let params = "";
  for (let p = 0; p < pages; p++) {
    let d: any;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${host}/api/v2/tokens/${contract}/holders${params}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(25_000),
        });
        lastStatus = r.status;
        if (r.status === 403 || r.status === 429) {
          await new Promise((res) => setTimeout(res, 1200 * (attempt + 1)));
          continue;
        }
        if (!r.ok) break;
        d = await r.json();
        break;
      } catch {
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
    if (!d) {
      if (out.length) break;
      return {
        rows: [],
        error: lastStatus === 403 || lastStatus === 429
          ? `Blockscout HTTP ${lastStatus} (rate limited / Cloudflare challenge)`
          : `Blockscout unreachable${lastStatus ? ` (HTTP ${lastStatus})` : ""}`,
      };
    }
    const items: any[] = d?.items ?? [];
    for (const it of items) {
      const a = it.address ?? {};
      const addr: string = a.hash ?? "";
      if (!addr || BURN.has(addr.toLowerCase())) continue;
      const tags: any[] = a.metadata?.tags ?? [];
      const label = [a.name ?? "", ...tags.map((t) => t.name ?? "")].join(" ").toLowerCase();
      if (INFRA_WORDS.some((w) => label.includes(w))) continue;
      if (tags.some((t) => String(t.slug ?? "").toLowerCase().includes("null"))) continue;
      try {
        out.push([addr, Number(BigInt(it.value ?? "0")) / 10 ** dec]);
      } catch {
        /* skip unparseable balance */
      }
    }
    const next = d?.next_page_params;
    if (!next || !items.length) break;
    params = "?" + new URLSearchParams(
      Object.entries(next).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
  }
  return { rows: out, error: null };
}

async function findEvmHolder(
  chainId: number,
  contract: string,
  target: number,
): Promise<{ rows: [string, number][]; method: string; error: string | null }> {
  const cfg = EVM_CHAINS[chainId];
  let bitqueryError: string | null = null;

  if (haveBitquery()) {
    for (const band of BANDS) {
      try {
        const rows = (await bitqueryHolders(
          cfg.bitquery, contract, target * (1 - band), target * (1 + band),
        )).filter(([a]) => !BURN.has(a.toLowerCase()));
        if (rows.length) {
          rows.sort((a, b) => Math.abs(a[1] - target) - Math.abs(b[1] - target));
          return { rows, method: "bitquery", error: null };
        }
      } catch (e) {
        // A configured key can still be out of points — fall through to the free path
        // rather than reporting the chain as unresolvable.
        bitqueryError = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (bitqueryError === null) return { rows: [], method: "bitquery", error: null };
  }

  if (!cfg.blockscout) {
    return {
      rows: [],
      method: "none",
      error: bitqueryError ?? "no free holder source for this chain",
    };
  }

  const prefix = bitqueryError ? `bitquery unavailable (${bitqueryError}); ` : "";
  const { rows, error: bsError } = await blockscoutHolders(cfg.blockscout, chainId, contract);
  if (!rows.length) {
    return {
      rows: [],
      method: "blockscout",
      error: prefix + (bsError ?? "no holders returned"),
    };
  }
  for (const band of BANDS) {
    const hit = rows.filter(([, amt]) => Math.abs(amt - target) / target <= band);
    if (hit.length) {
      hit.sort((a, b) => Math.abs(a[1] - target) - Math.abs(b[1] - target));
      return { rows: hit, method: "blockscout", error: null };
    }
  }
  // Present but not matched: the position sits far below a free top-100 holder list.
  const smallest = Math.min(...rows.map((r) => r[1]));
  return {
    rows: [],
    method: "blockscout",
    error: target < smallest
      ? prefix + "position too small for a free top-100 holder list"
      : prefix || null,
  };
}

function score(matches: Match[]): number {
  return Math.min(...matches.map((m) => m.off_by));
}

export async function resolveEvm(trader: Trader): Promise<Resolution> {
  const holdings = (trader.holdings ?? []).filter(
    (h: Holding) =>
      h.networkId !== undefined &&
      EVM_CHAINS[h.networkId] &&
      h.tokenAddress &&
      (h.humanAmount ?? 0) > 0,
  );
  if (!holdings.length) {
    return { address: null, confidence: "no-evm-holdings", matches: [], method: null, notes: [] };
  }

  const candidates = new Map<string, { address: string; matches: Match[] }>();
  const notes: string[] = [];
  const methods = new Set<string>();

  for (const h of holdings) {
    const cid = h.networkId!;
    const contract = h.tokenAddress!;
    const target = h.humanAmount!;
    const { rows, method, error } = await findEvmHolder(cid, contract, target);
    methods.add(method);
    if (error) notes.push(`${EVM_CHAINS[cid].name}: ${error}`);
    for (const [addr, amt] of rows.slice(0, 5)) {
      const rec = candidates.get(addr.toLowerCase()) ?? { address: addr, matches: [] };
      rec.matches.push({
        chain: EVM_CHAINS[cid].name,
        token: contract,
        reported: target,
        onchain: amt,
        off_by: Math.abs(amt - target) / target,
        via: method,
      });
      candidates.set(addr.toLowerCase(), rec);
    }
  }

  if (!candidates.size) {
    return {
      address: null,
      confidence: "unresolved",
      matches: [],
      method: [...methods].sort().join("/") || null,
      notes,
    };
  }

  const best = [...candidates.values()].sort(
    (a, b) => b.matches.length - a.matches.length || score(a.matches) - score(b.matches),
  )[0];

  // Confirm on the trader's other positions with a plain balanceOf — free, and it
  // reaches chains that have no holder list at all.
  for (const h of holdings) {
    const cid = h.networkId!;
    const contract = h.tokenAddress!;
    const target = h.humanAmount!;
    if (best.matches.some((m) => m.token.toLowerCase() === contract.toLowerCase())) continue;
    const bal = await balanceOf(cid, contract, best.address);
    if (bal && Math.abs(bal - target) / target <= TOLERANCE) {
      best.matches.push({
        chain: EVM_CHAINS[cid].name,
        token: contract,
        reported: target,
        onchain: bal,
        off_by: Math.abs(bal - target) / target,
        via: "balanceOf",
      });
    }
  }

  const bestOff = score(best.matches);
  let confidence: string;
  if (best.matches.length >= 2) {
    confidence = "confirmed";
  } else {
    const rivals = [...candidates.values()]
      .filter((c) => c.address.toLowerCase() !== best.address.toLowerCase())
      .map((c) => score(c.matches))
      .sort((a, b) => a - b);
    const clear = !rivals.length || (bestOff <= 0.01 && rivals[0] > bestOff * 5);
    confidence = clear ? "high-candidate" : "ambiguous";
  }

  return {
    address: best.address,
    confidence,
    matches: best.matches,
    best_off_by: bestOff,
    method: [...methods].sort().join("/"),
    candidates_considered: candidates.size,
    notes,
  };
}

// ------------------------------------------------------------------- Solana: Helius

const heliusRpc = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

async function solRpc(method: string, params: unknown): Promise<any> {
  try {
    const r = await fetch(heliusRpc(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const j: any = await r.json();
    return j?.error ? null : j?.result ?? null;
  } catch {
    return null;
  }
}

/** Top-20 holders, owner-resolved. 2 credits — the cheap path. */
async function largestHolders(mint: string): Promise<[string, number][]> {
  const largest = await solRpc("getTokenLargestAccounts", [mint]);
  const accounts: any[] = largest?.value ?? [];
  if (!accounts.length) return [];
  const infos = await solRpc("getMultipleAccounts", [
    accounts.map((a) => a.address),
    { encoding: "jsonParsed" },
  ]);
  const values: any[] = infos?.value ?? [];
  const out: [string, number][] = [];
  accounts.forEach((acc, i) => {
    const owner = values[i]?.data?.parsed?.info?.owner;
    const amt = Number(acc.uiAmount);
    if (owner && Number.isFinite(amt)) out.push([owner, amt]);
  });
  return out;
}

/** Every holder of a mint via DAS. 10 credits/page — the fallback. */
async function allHolders(mint: string, maxPages = 20): Promise<[string, number][]> {
  const supply = await solRpc("getTokenSupply", [mint]);
  const dec = Number(supply?.value?.decimals ?? 0);
  const totals = new Map<string, number>();
  let cursor: string | undefined;
  for (let p = 0; p < maxPages; p++) {
    const params: Record<string, unknown> = { mint, limit: 1000 };
    if (cursor) params.cursor = cursor;
    const res = await solRpc("getTokenAccounts", params);
    const accounts: any[] = res?.token_accounts ?? [];
    for (const a of accounts) {
      if (!a.owner || !a.amount) continue;
      // one owner can hold several token accounts for the same mint
      totals.set(a.owner, (totals.get(a.owner) ?? 0) + Number(BigInt(a.amount)) / 10 ** dec);
    }
    cursor = res?.cursor;
    if (!cursor || !accounts.length) break;
    await new Promise((r) => setTimeout(r, 550)); // free tier caps DAS at 2 req/sec
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

async function solBalanceOf(owner: string, mint: string): Promise<number> {
  const res = await solRpc("getTokenAccountsByOwner", [
    owner, { mint }, { encoding: "jsonParsed" },
  ]);
  let total = 0;
  for (const acc of res?.value ?? []) {
    total += Number(acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
  }
  return total;
}

export async function resolveSolana(trader: Trader): Promise<Resolution> {
  const holdings = (trader.holdings ?? []).filter(
    (h) => h.networkId === SOLANA_NETWORK_ID && h.tokenAddress && (h.humanAmount ?? 0) > 0,
  );
  if (!holdings.length) {
    return { address: null, confidence: "no-sol-holdings", matches: [], notes: [] };
  }
  if (!haveHelius()) {
    return {
      address: null,
      confidence: "no-helius-key",
      matches: [],
      notes: ["HELIUS_SOLANA_KEY is not set"],
    };
  }

  const candidates = new Map<string, { address: string; matches: Match[] }>();
  const notes: string[] = [];

  for (const h of holdings) {
    const mint = h.tokenAddress!;
    const target = h.humanAmount!;
    let rows = await largestHolders(mint);
    let source = "top20";
    let hit = rows.filter(([, a]) => Math.abs(a - target) / target <= TOLERANCE);
    if (!hit.length) {
      rows = await allHolders(mint);
      source = "das";
      hit = rows.filter(([, a]) => Math.abs(a - target) / target <= TOLERANCE);
    }
    if (!hit.length) notes.push(`solana: no holder near ${target} of ${mint.slice(0, 10)}…`);
    for (const [owner, amt] of hit) {
      const rec = candidates.get(owner) ?? { address: owner, matches: [] };
      rec.matches.push({
        chain: "solana",
        token: mint,
        reported: target,
        onchain: amt,
        off_by: Math.abs(amt - target) / target,
        via: source,
      });
      candidates.set(owner, rec);
    }
  }

  if (!candidates.size) {
    return { address: null, confidence: "unresolved", matches: [], notes };
  }

  const best = [...candidates.values()].sort(
    (a, b) => b.matches.length - a.matches.length || score(a.matches) - score(b.matches),
  )[0];

  for (const h of holdings) {
    const mint = h.tokenAddress!;
    const target = h.humanAmount!;
    if (best.matches.some((m) => m.token === mint)) continue;
    const bal = await solBalanceOf(best.address, mint);
    if (bal && Math.abs(bal - target) / target <= TOLERANCE) {
      best.matches.push({
        chain: "solana",
        token: mint,
        reported: target,
        onchain: bal,
        off_by: Math.abs(bal - target) / target,
        via: "balanceOf",
      });
    }
  }

  const bestOff = score(best.matches);
  let confidence: string;
  if (best.matches.length >= 2) {
    confidence = "confirmed";
  } else {
    const rivals = [...candidates.values()]
      .filter((c) => c.address !== best.address)
      .map((c) => score(c.matches))
      .sort((a, b) => a - b);
    const clear = !rivals.length || (bestOff <= 0.01 && rivals[0] > bestOff * 5);
    confidence = clear ? "high-candidate" : "ambiguous";
  }

  return {
    address: best.address,
    confidence,
    matches: best.matches,
    best_off_by: bestOff,
    candidates_considered: candidates.size,
    notes,
  };
}

/** Both chains in parallel — different providers, different quotas. */
export async function resolveAll(trader: Trader) {
  const started = Date.now();
  const [evm, solana] = await Promise.all([resolveEvm(trader), resolveSolana(trader)]);
  return { evm, solana, elapsed_ms: Date.now() - started };
}
