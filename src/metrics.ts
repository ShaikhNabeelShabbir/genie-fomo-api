import type { Holding, Trader } from "./directory.js";

/**
 * Derived trader metrics computed from the directory snapshot alone.
 *
 * Everything here is pure arithmetic over `data/wallet.full.data.json` — no API calls, no
 * key, no rate limit, no staleness beyond the file's own. That is deliberate: these are the
 * parameters that can ship without any external dependency (see PARAMETERS.md).
 */

/**
 * Stablecoins and native/wrapped assets — the currency, not a trade.
 *
 * Holding USDC is not a position, and treating it as one wrecks every metric that ranks by
 * value or counts holders. Measured on the current snapshot: 85 of 100 leaders "hold" USDC
 * and 53 hold wrapped SOL, so without this list the top of any board is just money.
 */
const QUOTE_ASSETS = new Set(
  [
    // Solana
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    "So11111111111111111111111111111111111111112", // wrapped SOL
    "11111111111111111111111111111111", // native SOL placeholder
    // EVM — USDC/USDT/wrapped natives across our chains
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC eth
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT eth
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH eth
    "0x4200000000000000000000000000000000000006", // WETH base
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC bsc
    "0x55d398326f99059ff775485246999027b3197955", // USDT bsc
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB bsc
  ].map((a) => a.toLowerCase()),
);

export const isQuoteAsset = (tokenAddress: string): boolean =>
  QUOTE_ASSETS.has(tokenAddress.toLowerCase());

/** A position we could actually put a dollar value on. */
type Priced = { tokenAddress: string; networkId: number; value: number; humanAmount: number };

function priced(holdings: Holding[]): Priced[] {
  const out: Priced[] = [];
  for (const h of holdings) {
    // `value` is null on ~22% of rows in the current snapshot. A missing value is not a
    // zero — including it as 0 would silently understate the denominator and inflate the
    // top share, which is the exact number we are trying to report honestly.
    if (!h.tokenAddress || h.networkId === undefined) continue;
    const v = typeof h.value === "number" && Number.isFinite(h.value) ? h.value : null;
    if (v === null || v <= 0) continue;
    out.push({
      tokenAddress: h.tokenAddress,
      networkId: h.networkId,
      value: v,
      humanAmount: typeof h.humanAmount === "number" ? h.humanAmount : 0,
    });
  }
  return out;
}

export type Portfolio = {
  /** T11 — every position, priced or not. Never shown without `concentration`. */
  positions: number;
  /** T13 — largest priced position as a share of total priced value, 0..1. */
  concentration: number | null;
  /** The position that share belongs to. */
  topPosition: { tokenAddress: string; networkId: number; valueUsd: number } | null;
  totalValueUsd: number | null;
  /** T14 — share of value sitting in stablecoins/native, i.e. not at risk. */
  cashShare: number | null;
  /**
   * What the numbers are actually built on. Showing a share without saying how much of the
   * portfolio it covers is the subtlest way to mislead — 441 of 2,012 rows in the current
   * snapshot carry no price at all.
   */
  coverage: { pricedPositions: number; unpricedPositions: number; pricedShare: number | null };
  /** True when under half the positions could be priced — badge the number, do not lead with it. */
  partial: boolean;
  /** Ready-made sentence, because the pairing rule matters more than the ratio. */
  plain: string;
};

export function portfolio(trader: Trader): Portfolio {
  const holdings = trader.holdings ?? [];
  const rows = priced(holdings);
  const unpriced = holdings.length - rows.length;

  const base: Portfolio = {
    positions: holdings.length,
    concentration: null,
    topPosition: null,
    totalValueUsd: null,
    cashShare: null,
    coverage: {
      pricedPositions: rows.length,
      unpricedPositions: unpriced,
      pricedShare: holdings.length ? Number((rows.length / holdings.length).toFixed(4)) : null,
    },
    partial: holdings.length > 0 && rows.length / holdings.length < 0.5,
    plain:
      holdings.length === 0
        ? "No positions on record."
        : "Holds positions, but none of them have a usable price — we cannot say how concentrated this is.",
  };
  if (!rows.length) return base;

  const total = rows.reduce((s, r) => s + r.value, 0);
  const top = rows.reduce((a, b) => (b.value > a.value ? b : a));
  const cash = rows.filter((r) => isQuoteAsset(r.tokenAddress)).reduce((s, r) => s + r.value, 0);

  const share = total > 0 ? top.value / total : null;
  const pct = share === null ? null : Math.round(share * 100);

  // The sentence exists because the ratio alone misleads: "95 positions" reads as
  // diversified when 97% of the money is in one of them.
  let plain: string;
  if (rows.length === 1) {
    plain = "Everything is in a single coin — there is nothing to spread the risk.";
  } else if (pct !== null && pct >= 90) {
    plain = `Holds ${holdings.length} coins, but ${pct}% of the money is in just one of them.`;
  } else if (pct !== null && pct >= 50) {
    plain = `Holds ${holdings.length} coins, with ${pct}% of the money in the biggest one.`;
  } else {
    plain = `Holds ${holdings.length} coins, spread fairly evenly — the biggest is ${pct}% of the money.`;
  }
  // When most of the portfolio has no price, the caveat has to LEAD. Measured: unipcs has
  // 95 positions and only 42 priced, so a trailing footnote would let a 97% figure stand on
  // 44% of the evidence.
  const cover = rows.length / holdings.length;
  if (cover < 0.5) {
    plain =
      `Only ${rows.length} of ${holdings.length} positions have a usable price, so this is a ` +
      `partial picture. Of what we can see, ${pct}% sits in one coin.`;
  } else if (unpriced > 0) {
    plain += ` (${unpriced} position${unpriced === 1 ? "" : "s"} had no price and are excluded.)`;
  }

  return {
    ...base,
    concentration: share === null ? null : Number(share.toFixed(4)),
    topPosition: { tokenAddress: top.tokenAddress, networkId: top.networkId, valueUsd: Number(top.value.toFixed(2)) },
    totalValueUsd: Number(total.toFixed(2)),
    cashShare: total > 0 ? Number((cash / total).toFixed(4)) : null,
    plain,
  };
}

// ---------------------------------------------------------------- K1 / K4

import { EVM_CHAINS, SOLANA_NETWORK_ID } from "./settings.js";

export const chainName = (networkId: number): string =>
  networkId === SOLANA_NETWORK_ID ? "solana" : (EVM_CHAINS[networkId]?.name ?? String(networkId));

export type TokenRow = {
  tokenAddress: string;
  networkId: number;
  chain: string;
  /** K1 — how many leaders hold it. */
  holders: number;
  /** Share of the whole board, so "25" reads against a denominator. */
  holderShare: number;
  /** Summed across holders we could price; null when none could be. */
  totalValueUsd: number | null;
  /** K4 — who else holds it, biggest position first. */
  holderHandles: string[];
  plain: string;
};

/**
 * K1 — tokens ranked by how many leaders hold them, i.e. what the board is crowding into.
 *
 * Pure inversion of `holdings[]` into a token -> traders index. No API call.
 *
 * Quote assets are excluded and it is not optional: measured on the current snapshot, 85 of
 * 100 leaders "hold" USDC and 53 hold wrapped SOL. Leaving them in makes the entire top of
 * the board the currency rather than a trade.
 *
 * Crowding is deliberately NOT framed as a recommendation. 34 of 150 traders once held the
 * same honeypot — consensus can mean a good call or a coordinated pump, and this number
 * cannot tell them apart.
 */
export function tokenBoard(
  traders: Trader[],
  opts: { chain?: number | null; minHolders?: number } = {},
): {
  rows: TokenRow[];
  totalTokens: number;
  excluded: { tokens: number; positions: number };
  traderCount: number;
} {
  const minHolders = opts.minHolders ?? 1;
  const byToken = new Map<
    string,
    { tokenAddress: string; networkId: number; holders: Set<string>; value: number; priced: boolean;
      byHandle: { handle: string; value: number }[] }
  >();
  // Count BOTH: how many distinct quote tokens were dropped, and how many holding rows
  // they accounted for. Reporting one number for "excluded" conflates 5 assets with the
  // 157 positions they appear in.
  const quoteTokens = new Set<string>();
  let quoteRows = 0;

  for (const t of traders) {
    if (!t.handle) continue;
    for (const h of t.holdings ?? []) {
      if (!h.tokenAddress || h.networkId === undefined) continue;
      if (opts.chain != null && h.networkId !== opts.chain) continue;
      const key = `${h.networkId}:${h.tokenAddress.toLowerCase()}`;
      if (isQuoteAsset(h.tokenAddress)) {
        quoteTokens.add(key);
        quoteRows++;
        continue;
      }
      const rec = byToken.get(key) ?? {
        tokenAddress: h.tokenAddress, networkId: h.networkId,
        holders: new Set<string>(), value: 0, priced: false, byHandle: [],
      };
      rec.holders.add(t.handle);
      const v = typeof h.value === "number" && Number.isFinite(h.value) && h.value > 0 ? h.value : 0;
      if (v > 0) { rec.value += v; rec.priced = true; }
      rec.byHandle.push({ handle: t.handle, value: v });
      byToken.set(key, rec);
    }
  }

  const traderCount = traders.filter((t) => t.handle).length;
  const rows: TokenRow[] = [...byToken.values()]
    .filter((r) => r.holders.size >= minHolders)
    .map((r) => {
      const holders = r.holders.size;
      const share = traderCount ? holders / traderCount : 0;
      // Biggest position first: who has the most conviction, not who happens to be first.
      const handles = [...new Map(r.byHandle.map((x) => [x.handle, x])).values()]
        .sort((a, b) => b.value - a.value)
        .map((x) => x.handle);
      return {
        tokenAddress: r.tokenAddress,
        networkId: r.networkId,
        chain: chainName(r.networkId),
        holders,
        holderShare: Number(share.toFixed(4)),
        totalValueUsd: r.priced ? Number(r.value.toFixed(2)) : null,
        holderHandles: handles,
        plain:
          holders === 1
            ? `Only 1 of ${traderCount} leaders holds this.`
            : `${holders} of ${traderCount} leaders hold this.`,
      };
    })
    .sort((a, b) => b.holders - a.holders || (b.totalValueUsd ?? 0) - (a.totalValueUsd ?? 0));

  return {
    rows,
    totalTokens: byToken.size,
    excluded: { tokens: quoteTokens.size, positions: quoteRows },
    traderCount,
  };
}
