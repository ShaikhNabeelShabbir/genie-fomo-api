import type { Holding, Trader } from "./directory.js";
import { EVM_CHAINS, SOLANA_NETWORK_ID } from "./settings.js";

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
      byHandle: { handle: string; value: number; rank: number | undefined }[] }
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
      rec.byHandle.push({ handle: t.handle, value: v, rank: t.rank });
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
        .sort((a, b) => b.value - a.value || (a.rank ?? 9999) - (b.rank ?? 9999))
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
    // The third term is load-bearing. Hundreds of tokens tie on holder count with no
    // price at all, and without a deterministic tiebreak their order depends on the order
    // traders happened to come out of the directory — so the same request could return a
    // different board twice. Address is arbitrary but stable, which is the point.
    .sort((a, b) =>
      b.holders - a.holders ||
      (b.totalValueUsd ?? 0) - (a.totalValueUsd ?? 0) ||
      a.tokenAddress.toLowerCase().localeCompare(b.tokenAddress.toLowerCase()) ||
      // Address alone is not unique: the same address exists on two chains in the current
      // snapshot, so the network is the final term.
      a.networkId - b.networkId);

  return {
    rows,
    totalTokens: byToken.size,
    excluded: { tokens: quoteTokens.size, positions: quoteRows },
    traderCount,
  };
}

// ------------------------------------------------------------------- T12

export type Position = {
  tokenAddress: string;
  networkId: number;
  chain: string;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  /** Share of the trader's *priced* portfolio, so it sums to 1 across priced rows. */
  share: number | null;
  isQuoteAsset: boolean;
};

/**
 * T12 — what a trader actually holds, biggest first.
 *
 * `/portfolio` says how concentrated someone is but not in what; this answers that.
 * Unpriced rows are RETURNED rather than dropped — they are part of the portfolio even
 * when we cannot value them, and hiding them would misrepresent the position count.
 * They sort last and carry `valueUsd: null`, never 0.
 */
export function positions(trader: Trader): { rows: Position[]; totalValueUsd: number | null } {
  const holdings = (trader.holdings ?? []).filter((h) => h.tokenAddress && h.networkId !== undefined);
  const val = (h: Holding) =>
    typeof h.value === "number" && Number.isFinite(h.value) && h.value > 0 ? h.value : null;
  const total = holdings.reduce((s, h) => s + (val(h) ?? 0), 0);

  const rows: Position[] = holdings
    .map((h) => {
      const v = val(h);
      return {
        tokenAddress: h.tokenAddress!,
        networkId: h.networkId!,
        chain: chainName(h.networkId!),
        amount: typeof h.humanAmount === "number" ? h.humanAmount : 0,
        priceUsd: typeof h.price === "number" && Number.isFinite(h.price) ? h.price : null,
        valueUsd: v === null ? null : Number(v.toFixed(2)),
        share: v !== null && total > 0 ? Number((v / total).toFixed(4)) : null,
        isQuoteAsset: isQuoteAsset(h.tokenAddress!),
      };
    })
    // Priced rows first, descending; unpriced trail rather than masquerading as zero.
    // Address breaks the tie among unpriced rows, which would otherwise come back in
    // whatever order the storage layer happened to produce.
    .sort((a, b) =>
      (b.valueUsd ?? -1) - (a.valueUsd ?? -1) ||
      a.tokenAddress.toLowerCase().localeCompare(b.tokenAddress.toLowerCase()));

  return { rows, totalValueUsd: total > 0 ? Number(total.toFixed(2)) : null };
}

// ------------------------------------------------- token detail (K1/K3/K4/C5)

export type TokenDetail = TokenRow & {
  holders_detail: { handle: string; amount: number; valueUsd: number | null }[];
};

/**
 * One token: who holds it, how much, and on which chain.
 *
 * A token address can exist on more than one chain (2 of our 908 do), so `networkId`
 * disambiguates. Without it we return every match rather than silently picking one.
 */
export function tokenDetail(
  traders: Trader[],
  tokenAddress: string,
  networkId?: number | null,
): TokenDetail[] {
  const needle = tokenAddress.toLowerCase();
  const byKey = new Map<string, { networkId: number; addr: string;
    holders: { handle: string; amount: number; valueUsd: number | null }[] }>();

  for (const t of traders) {
    if (!t.handle) continue;
    for (const h of t.holdings ?? []) {
      if (!h.tokenAddress || h.networkId === undefined) continue;
      if (h.tokenAddress.toLowerCase() !== needle) continue;
      if (networkId != null && h.networkId !== networkId) continue;
      const key = String(h.networkId);
      const rec = byKey.get(key) ?? { networkId: h.networkId, addr: h.tokenAddress, holders: [] };
      const v = typeof h.value === "number" && Number.isFinite(h.value) && h.value > 0 ? h.value : null;
      rec.holders.push({
        handle: t.handle,
        amount: typeof h.humanAmount === "number" ? h.humanAmount : 0,
        valueUsd: v === null ? null : Number(v.toFixed(2)),
      });
      byKey.set(key, rec);
    }
  }

  const traderCount = traders.filter((t) => t.handle).length;
  return [...byKey.values()].map((r) => {
    const priced = r.holders.filter((h) => h.valueUsd !== null);
    const total = priced.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
    const holders = new Set(r.holders.map((h) => h.handle)).size;
    const sortedHolders = [...r.holders].sort(
      (a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1) || a.handle.localeCompare(b.handle));
    return {
      tokenAddress: r.addr,
      networkId: r.networkId,
      chain: chainName(r.networkId),
      holders,
      holderShare: Number((traderCount ? holders / traderCount : 0).toFixed(4)),
      totalValueUsd: priced.length ? Number(total.toFixed(2)) : null,
      holderHandles: sortedHolders.map((h) => h.handle),
      holders_detail: sortedHolders,
      plain:
        holders === 1
          ? `Only 1 of ${traderCount} leaders holds this.`
          : `${holders} of ${traderCount} leaders hold this.`,
    };
  });
}

// ------------------------------------------------------------- trust flags

export type Flag = { code: string; severity: "warn" | "info"; plain: string };

export type Trust = {
  flags: Flag[];
  /** Ratio of claimed profit to lifetime volume. Above 1 the claim exceeds all trading. */
  pnlToVolume: number | null;
  /** Ratio of claimed profit to everything they currently hold. */
  pnlToHoldings: number | null;
  trades: number | null;
  verdict: "implausible" | "unverified" | "insufficient" | "ok";
  plain: string;
};

/**
 * Trust flags — pure file arithmetic, no API call.
 *
 * This exists because the leaderboard's own numbers frequently do not survive their own
 * arithmetic. Measured on the current snapshot of 100 traders:
 *
 *   45 claim a `pnl` LARGER than their entire lifetime `volume`
 *   64 claim a `pnl` more than 10x the value of everything they hold
 *
 * Nearly half the board reports profit that cannot be reconciled with its own trading.
 * Without this, a reader sees a ranked list of profits with nothing indicating that most
 * of them are unsupportable.
 *
 * These are plausibility checks, NOT fraud findings. A high ratio means the number cannot
 * be corroborated from the data we hold — it does not prove intent.
 */
export function trust(trader: Trader): Trust {
  const pnl = typeof trader.pnl === "number" ? trader.pnl : null;
  const volume = typeof trader.volume === "number" ? trader.volume : null;
  const trades = typeof trader.trades === "number" ? trader.trades : null;
  const holdingsValue = (trader.holdings ?? []).reduce(
    (s, h) => s + (typeof h.value === "number" && Number.isFinite(h.value) && h.value > 0 ? h.value : 0),
    0,
  );

  const flags: Flag[] = [];
  const pnlToVolume = pnl !== null && volume !== null && volume > 0 ? Number((pnl / volume).toFixed(2)) : null;
  const pnlToHoldings = pnl !== null && holdingsValue > 0 ? Number((pnl / holdingsValue).toFixed(2)) : null;

  if (pnlToVolume !== null && pnlToVolume > 1) {
    flags.push({
      code: "pnl_exceeds_volume",
      severity: "warn",
      plain:
        `Reported profit ($${Math.round(pnl!).toLocaleString("en-US")}) is larger than everything ` +
        `they have ever traded ($${Math.round(volume!).toLocaleString("en-US")}). That cannot come from trading alone.`,
    });
  }
  if (pnlToHoldings !== null && pnlToHoldings > 10) {
    flags.push({
      code: "pnl_exceeds_holdings",
      severity: "warn",
      plain:
        `Reported profit is ${Math.round(pnlToHoldings)}x the value of everything they currently hold — ` +
        `the money is not visible in the portfolio.`,
    });
  }
  if (trades !== null && trades < 10) {
    flags.push({
      code: "too_few_trades",
      severity: "warn",
      plain: `Only ${trades} trade${trades === 1 ? "" : "s"} on record — far too few to tell skill from luck.`,
    });
  }
  const p = portfolio(trader);
  if (p.partial) {
    flags.push({
      code: "partial_pricing",
      severity: "info",
      plain: `Only ${p.coverage.pricedPositions} of ${p.positions} positions have a usable price, so portfolio figures are incomplete.`,
    });
  }

  const verdict: Trust["verdict"] =
    flags.some((f) => f.code === "pnl_exceeds_volume") ? "implausible"
      : flags.some((f) => f.code === "pnl_exceeds_holdings") ? "unverified"
      : flags.some((f) => f.code === "too_few_trades") ? "insufficient"
      : "ok";

  const plain =
    verdict === "implausible"
      ? "The reported profit does not reconcile with this trader's own trading volume. Treat it as unproven."
      : verdict === "unverified"
      ? "The reported profit is far larger than the portfolio we can see, so we cannot corroborate it."
      : verdict === "insufficient"
      ? "There is not enough trading history here to judge skill."
      : "Nothing in the numbers contradicts itself.";

  return { flags, pnlToVolume, pnlToHoldings, trades, verdict, plain };
}

// ------------------------------------------------------------- C1 / C2 / C5

export type ChainRow = {
  networkId: number;
  chain: string;
  /** C1 — distinct leaders holding anything here. */
  traders: number;
  /** Share of the board, so "63" reads against a denominator. */
  traderShare: number;
  positions: number;
  /** Distinct non-quote tokens seen on this chain. */
  tokens: number;
  /** C2 — summed value of the positions we could price. Null when none could be. */
  totalValueUsd: number | null;
  /**
   * What that total is built on. A chain where 8 of 226 rows carry a price produces a
   * number that looks authoritative and is not, so the denominator travels with it.
   */
  coverage: { pricedPositions: number; unpricedPositions: number; pricedShare: number | null };
  plain: string;
};

/**
 * C1 + C2 — where the leaderboard actually trades, and how much sits on each chain.
 *
 * Pure inversion of the snapshot by `networkId`; no API call. This section exists because
 * *what we can see differs by chain*, which constrains every other parameter: history is
 * free on Solana and Robinhood, and absent on BSC and Base without a paid provider.
 *
 * Quote assets are counted separately rather than dropped outright. On a chain board they
 * are genuinely informative — a chain whose entire value is USDC is a parking lot, not a
 * market — but they must not be mistaken for positions, so `tokens` excludes them while
 * `totalValueUsd` reports both.
 */
export function chainBoard(traders: Trader[]): {
  rows: ChainRow[];
  traderCount: number;
  totalPositions: number;
} {
  const by = new Map<
    number,
    {
      handles: Set<string>;
      tokens: Set<string>;
      positions: number;
      value: number;
      priced: number;
      quoteValue: number;
    }
  >();

  let totalPositions = 0;
  for (const t of traders) {
    if (!t.handle) continue;
    for (const h of t.holdings ?? []) {
      if (!h.tokenAddress || h.networkId === undefined) continue;
      totalPositions++;
      const rec =
        by.get(h.networkId) ??
        { handles: new Set<string>(), tokens: new Set<string>(), positions: 0, value: 0, priced: 0, quoteValue: 0 };
      rec.handles.add(t.handle);
      rec.positions++;
      const quote = isQuoteAsset(h.tokenAddress);
      if (!quote) rec.tokens.add(h.tokenAddress.toLowerCase());
      const v = typeof h.value === "number" && Number.isFinite(h.value) && h.value > 0 ? h.value : null;
      if (v !== null) {
        rec.priced++;
        rec.value += v;
        if (quote) rec.quoteValue += v;
      }
      by.set(h.networkId, rec);
    }
  }

  const traderCount = traders.filter((t) => t.handle).length;
  const rows: ChainRow[] = [...by.entries()]
    .map(([networkId, r]) => {
      const share = traderCount ? r.handles.size / traderCount : 0;
      const pricedShare = r.positions ? r.priced / r.positions : null;
      const name = chainName(networkId);
      // Lead with the caveat when the money figure rests on a minority of the rows.
      const plain =
        pricedShare !== null && pricedShare < 0.5
          ? `${r.handles.size} of ${traderCount} leaders trade ${name}, but only ${r.priced} of ` +
            `${r.positions} positions there have a usable price — the value figure is partial.`
          : `${r.handles.size} of ${traderCount} leaders trade ${name}, across ${r.positions} positions.`;
      return {
        networkId,
        chain: name,
        traders: r.handles.size,
        traderShare: Number(share.toFixed(4)),
        positions: r.positions,
        tokens: r.tokens.size,
        totalValueUsd: r.priced ? Number(r.value.toFixed(2)) : null,
        coverage: {
          pricedPositions: r.priced,
          unpricedPositions: r.positions - r.priced,
          pricedShare: pricedShare === null ? null : Number(pricedShare.toFixed(4)),
        },
        plain,
      };
    })
    .sort((a, b) => b.positions - a.positions);

  return { rows, traderCount, totalPositions };
}
