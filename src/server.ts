import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";

import * as directory from "./directory.js";
import type { Trader } from "./directory.js";
import { resolveAll, verifyCandidate } from "./resolvers.js";
import type { Resolution } from "./resolvers.js";
import { fetchTransactions } from "./transactions.js";
import * as hyperliquid from "./hyperliquid.js";
import * as pumpfun from "./pumpfun.js";
import * as gmgn from "./gmgn.js";
import { portfolio, tokenBoard, chainName, positions, tokenDetail, trust, chainBoard } from "./metrics.js";
import { banked, scorecard, tokenActivity, haveFomoapi } from "./fomoapi.js";
import * as snapshots from "./snapshots.js";
import { buildTrades, replay, summarise } from "./pnl.js";
import { asQuote } from "./prices.js";
import type { Transfer } from "./transactions.js";
import {
  API_KEY, CORS_ORIGINS, PORT, EVM_CHAINS, SOLANA_NETWORK_ID,
  haveBitquery, haveEtherscan, haveHelius,
} from "./settings.js";

/**
 * genie-fomo REST API (TypeScript).
 *
 *   GET /v1/traders/{handle}/wallets       username -> the wallets they actually trade from
 *   GET /v1/traders/{handle}/transactions  those wallets -> their live transactions
 *   GET /v1/traders/{handle}/trades        those transfers -> paired trades with per-trade PnL
 *   GET /v1/traders/{handle}/performance   the scorecard: realised vs unrealised, win rate
 *
 * Both resolve on every request. The input file is the raw build_directory.py output;
 * the real addresses are derived live from on-chain holder data each time, so responses
 * reflect the chain now rather than a snapshot.
 */

const app = express();
// Wide open unless CORS_ORIGINS is set. Restrict it in production: without a browser
// origin check, any site can drive requests that burn Helius credits and Bitquery points.
app.use(cors(CORS_ORIGINS.length ? { origin: CORS_ORIGINS } : {}));

/**
 * Authentication is OFF by default and that is the intended posture for now.
 * Setting GENIE_API_KEY turns it on with no other changes — see PROD-STEPS.md
 * ("Future hardening") for when to do that.
 */
function auth(req: Request, res: Response, next: NextFunction): void {
  if (API_KEY && req.header("X-API-Key") !== API_KEY) {
    res.status(401).json({ detail: "invalid or missing X-API-Key" });
    return;
  }
  next();
}

/** The trader as fomo describes them — never presented as a trading wallet. */
function publicTrader(t: Trader) {
  return {
    handle: t.handle,
    name: t.name,
    rank: t.rank,
    pnl_30d: t.pnl,
    volume: t.volume,
    trades: t.trades,
    followers: t.followers,
    verified: t.verified,
    fomo_reported_wallets: {
      evm: t.evm ?? null,
      solana: t.sol ?? null,
      note: "provisioned by fomo; holds none of the positions below",
    },
    holdings: t.holdings ?? [],
  };
}

app.get("/v1/health", (_req, res) => {
  res.json({
    status: "ok",
    runtime: "typescript",
    directory: directory.meta(),
    providers: {
      etherscan: {
        configured: haveEtherscan(),
        serves: ["ethereum transactions"],
        note: "free tier does not cover BSC or Base",
      },
      blockscout: {
        configured: true,
        serves: ["robinhood transactions", "robinhood/ethereum holder lists"],
        note: "no key required",
      },
      helius: {
        configured: haveHelius(),
        serves: ["solana address resolution", "solana transactions"],
      },
      bitquery: {
        configured: haveBitquery(),
        serves: ["evm address resolution (all 4 chains)", "bsc/base transactions"],
        note: haveBitquery()
          ? null
          : "not set — EVM resolution falls back to Blockscout (robinhood + ethereum, " +
            "large positions only); BSC/Base unavailable",
      },
    },
  });
});

/**
 * The whole board, in fomoscan's `/v2/leaderboard/traders` shape.
 *
 * `?q=` filters and `?limit=` takes the top N; `count` always describes the entries
 * actually returned. When a limit truncates the board, `total` appears alongside it — a
 * caller who asked for 3 of 150 should be able to see the 150. Without a limit the whole
 * board comes back and `total` is absent, matching fomoscan's un-paginated envelope.
 *
 * `memberCount`, `marketCap`, `price` and `liquidity` belong to the clan and token boards
 * that share this entry shape — they are null on a trader board, not missing data. `id` is
 * null because the directory carries no UUID for a trader; fomoscan mints its own.
 *
 * `capturedAt` is when build_directory.py read the leaderboard, in epoch SECONDS, straight
 * from the file. It is not a live sample: fomoscan re-reads FOMO every 30s, this is one
 * snapshot that ages until the pipeline is re-run.
 */
app.get("/v1/traders", auth, (req, res) => {
  const q = String(req.query.q ?? "");
  const meta = directory.meta();
  const { rows: board } = directory.search(q, Number.MAX_SAFE_INTEGER, 0);

  // Absent, unparseable or non-positive limits all mean "the whole board".
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const rows = limit === null ? board : board.slice(0, limit);

  res.json({
    board: "traders",
    window: meta.window ?? null,
    capturedAt: meta.generated_at ?? null,
    count: rows.length,
    ...(rows.length < board.length ? { total: board.length } : {}),
    entries: rows.map((t) => ({
      rank: t.rank ?? null,
      id: null,
      handle: t.handle,
      label: t.name ?? null,
      avatarUrl: nonEmpty(t.avatar),
      pnl: t.pnl ?? null,
      volume: t.volume ?? null,
      followers: t.followers ?? null,
      numTrades: t.trades ?? null,
      memberCount: null,
      marketCap: null,
      price: null,
      liquidity: null,
    })),
  });
});

/**
 * ENDPOINT 1 — username to the wallets they actually trade from.
 *
 * The response mirrors fomoscan's `/v2/user/handle/{handle}` field-for-field, so a caller
 * can point at either. The VALUES differ on purpose: fomoscan returns the wallet fomo
 * provisioned for the user, which holds none of their positions, while these are the
 * wallets the trading actually happens from — resolved live from on-chain holder data.
 *
 * Because the shape has nowhere to put a confidence rating, only `confirmed` addresses
 * are published. Anything weaker resolves to null rather than shipping a guess in a field
 * that reads as fact. `?verbose=true` shows every candidate with its confidence, the
 * per-match evidence and provider notes.
 *
 * `id` is omitted entirely: fomoscan mints its own UUID per user and the directory has no
 * equivalent, so there is nothing to key on. `banner` has no source either, and `twitter`
 * is empty for all 150 traders — both stay as null rather than being invented.
 */
/**
 * Resolution, verification first — used by every route that needs an address.
 *
 * When the directory carries a candidate address, asking "does this wallet hold the
 * reported positions" is a plain balanceOf: free, and it reaches BSC and Base. Holder-list
 * search is what spends Bitquery points, and on a directory sourced from fomoapi (~96
 * positions per trader rather than fomo's 3) it is also what turns a request into minutes
 * of DAS paging. So it runs only for chains verification could not settle.
 */
async function resolvePreferVerified(
  t: Trader,
): Promise<{ evm: Resolution; solana: Resolution; elapsed_ms: number;
             candidate: Awaited<ReturnType<typeof verifyCandidate>> | null }> {
  const candidate = t.src_evm || t.src_sol
    ? await verifyCandidate(t, t.src_evm || null, t.src_sol || null)
    : null;
  // Any on-chain evidence beats falling back: a verified `high-candidate` is a real
  // answer, while holder-list search may be quota-blocked and return nothing at all.
  const evmOk = !!candidate?.evm.address;
  const solOk = !!candidate?.solana.address;
  const full = evmOk && solOk ? null : await resolveAll(t);
  return {
    evm: evmOk ? candidate!.evm : full!.evm,
    solana: solOk ? candidate!.solana : full!.solana,
    elapsed_ms: (candidate?.elapsed_ms ?? 0) + (full?.elapsed_ms ?? 0),
    candidate,
  };
}

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
app.get("/v1/traders/:handle/wallets", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const r = await resolvePreferVerified(t);
  const cand = r.candidate;

  if (String(req.query.verbose ?? "") === "true") {
    res.json({
      trader: publicTrader(t),
      resolved_wallets: { evm: r.evm, solana: r.solana },
      third_party: t.src
        ? { source: t.src, evm: t.src_evm || null, solana: t.src_sol || null,
            verified_evm: cand?.evm.confidence ?? null,
            verified_solana: cand?.solana.confidence ?? null }
        : null,
      elapsed_ms: r.elapsed_ms,
    });
    return;
  }

  // A `confirmed` match publishes on its own: two independent token positions agreed on
  // the same wallet. A weaker match publishes only when an independent third-party
  // resolver landed on the same address — a different method reaching the same answer is
  // the same standard of evidence, and it is what lets a directory built without position
  // data still produce a trustworthy address. Disagreement publishes nothing.
  const publishable = (x: Resolution, thirdParty?: string) => {
    if (x.confidence === "confirmed") return x.address;
    if (!x.address || !thirdParty) return null;
    return x.address.toLowerCase() === thirdParty.toLowerCase() ? x.address : null;
  };

  res.json({
    handle: t.handle,
    name: t.name ?? null,
    bio: nonEmpty(t.bio),
    banner: null,
    profilePicture: nonEmpty(t.avatar),
    twitter: nonEmpty(t.twitter),
    solanaAddress: publishable(r.solana, t.src_sol),
    evmAddress: publishable(r.evm, t.src_evm),
  });
});

/**
 * ENDPOINT 2 — the resolved wallets' live transactions.
 * Read `chains[]` before trusting an empty list: `count: 0, error: null` means no
 * activity, while `count: 0, error: "..."` means that chain could not be reached.
 *
 * Slim by default; `?verbose=true` returns the full row this used to emit. What the slim
 * shape drops is duplication rather than information — see `slimTransfer`.
 *
 * Only `confirmed` wallets are scanned, so the addresses in `wallets` are exactly the
 * addresses the transfers came from — a caller can always tell whose activity this is.
 * The trade-off is coverage: `confirmed` needs two independent token positions to agree,
 * and 138 of the 150 traders hold fewer than two Solana tokens in the snapshot, so their
 * Solana activity is not reachable through this endpoint. /trades and /performance still
 * accept `high-candidate`, because the PnL replay is where that Solana history matters.
 */
/**
 * One transfer, without the parts that repeat something else in the same row.
 *
 *   time + time_iso  -> one ISO timestamp; the epoch copy said nothing extra
 *   from + to        -> `counterparty`, since `side` already says which end we are
 *   explorer_url     -> dropped; it is `chain` + `tx_hash` reassembled
 *   token            -> a REAL symbol or null. Solana rows carried "EPjF…Dt1v", which is a
 *                       truncated mint dressed up as a ticker: it reads like information
 *                       and is not. Known mints now resolve properly (that one is USDC).
 *   type/source      -> kept only when Helius actually decoded them
 */
function slimTransfer(t: Transfer) {
  const known = asQuote(t.chain, t.contract, t.token);
  const symbol = known ? known.symbol
    : t.token && !t.token.includes("…") ? t.token
    : null;
  const decoded = t.type && t.type !== "UNKNOWN" ? t.type : null;
  const via = t.source && t.source !== "UNKNOWN" ? t.source : null;

  return {
    chain: t.chain,
    tx_hash: t.tx_hash,
    time: t.time_iso,
    token: symbol,
    contract: t.contract,
    amount: t.amount,
    side: t.side,
    counterparty: t.side === "in" ? t.from : t.to,
    ...(decoded ? { type: decoded } : {}),
    ...(via ? { source: via } : {}),
  };
}

app.get("/v1/traders/:handle/transactions", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 300);
  const side = String(req.query.side ?? "");
  const includeEvidence = String(req.query.include_evidence ?? "") === "true";
  // Evidence is a debugging aid, so asking for it implies the full shape.
  const verbose = String(req.query.verbose ?? "") === "true" || includeEvidence;
  const wanted = String(req.query.chain ?? "")
    .split(",").map((c) => c.trim()).filter(Boolean);

  const r = await resolvePreferVerified(t);
  const { evm, solana } = r;

  // Only scan an address we actually trust. A weak match would attribute someone else's
  // transactions to this trader, which is worse than returning nothing.
  const evmAddr = evm.confidence === "confirmed" ? evm.address : null;
  const solAddr = solana.confidence === "confirmed" ? solana.address : null;

  const tx = await fetchTransactions(evmAddr, solAddr, wanted.length ? wanted : null, limit);
  const rows = side === "in" || side === "out"
    ? tx.transfers.filter((x) => x.side === side)
    : tx.transfers;

  // Verbose keeps every candidate and its confidence, including the ones withheld below.
  const scanned: Record<string, unknown> = {
    evm: {
      address: evmAddr, confidence: evm.confidence,
      method: evm.method, skipped: evmAddr === null,
      ...(includeEvidence ? { matches: evm.matches } : {}),
    },
    solana: {
      address: solAddr, confidence: solana.confidence,
      skipped: solAddr === null,
      ...(includeEvidence ? { matches: solana.matches } : {}),
    },
  };

  // Slim shape: since only confirmed wallets are scanned, `confidence` would be the same
  // constant on every row, so the address alone carries it. Unconfirmed chains are absent
  // rather than null — there is no wallet here to talk about.
  const wallets: Record<string, string> = {};
  if (evmAddr) wallets.evm = evmAddr;
  if (solAddr) wallets.solana = solAddr;

  // A chain that failed is not a chain with no activity. Reported only when it happens,
  // so a healthy response stays minimal but a degraded one is never silently short.
  const failed = tx.chains.filter((c) => c.error);

  const notes = [...evm.notes, ...solana.notes];
  if (evmAddr === null && evm.confidence !== "no-evm-holdings") {
    notes.push(`EVM not scanned — resolution was '${evm.confidence}'`);
  }
  if (solAddr === null && solana.confidence !== "no-sol-holdings") {
    notes.push(`Solana not scanned — resolution was '${solana.confidence}'`);
  }

  if (verbose) {
    res.json({
      trader: { handle: t.handle, name: t.name, rank: t.rank },
      scanned_wallets: scanned,
      chains: tx.chains,
      count: rows.length,
      transfers: rows,
      notes,
      resolve_ms: r.elapsed_ms,
      fetch_ms: tx.elapsed_ms,
      pulled_at: tx.pulled_at,
    });
    return;
  }

  res.json({
    wallets,
    transfers: rows.map(slimTransfer),
    ...(failed.length ? { errors: failed } : {}),
  });
});

/**
 * Resolution is the slow part — 4-30s of holder queries — and a wallet address barely
 * changes. Caching it keeps /trades and /performance usable interactively. In production
 * this belongs in the nightly job that pre-resolves the whole directory.
 */
const RESOLVE_TTL_MS = 15 * 60_000;
type Resolved = { evm: Resolution; solana: Resolution; elapsed_ms: number };
const resolveCache = new Map<string, { at: number; value: Resolved }>();

async function resolveCached(t: Trader): Promise<Resolved & { cached: boolean }> {
  const hit = resolveCache.get(t.handle);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return { ...hit.value, cached: true };
  const value = await resolvePreferVerified(t);
  resolveCache.set(t.handle, { at: Date.now(), value });
  return { ...value, cached: false };
}

const usableConfidence = new Set(["confirmed", "high-candidate"]);

/**
 * The PnL pipeline: resolve -> fetch OLDEST FIRST with native legs -> group by tx_hash ->
 * classify -> replay carrying a cost pool per token.
 *
 * The `order: "asc"` is not cosmetic. A sell can only be settled against purchases that
 * came before it, so the replay has to see them first. Any sell whose buy predates the
 * fetched window reports `realized_pnl_usd: null` with `basis_not_in_window` rather than
 * a zero basis, which would book the whole proceeds as profit.
 */
async function analyse(t: Trader, req: Request) {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 300) || 300, 1), 2000);
  const pages = Math.min(Math.max(Number(req.query.pages ?? 5) || 5, 1), 20);
  const wanted = String(req.query.chain ?? "")
    .split(",").map((c) => c.trim()).filter(Boolean);

  const r = await resolveCached(t);
  const evmAddr = usableConfidence.has(r.evm.confidence) ? r.evm.address : null;
  const solAddr = usableConfidence.has(r.solana.confidence) ? r.solana.address : null;

  const tx = await fetchTransactions(
    evmAddr, solAddr, wanted.length ? wanted : null, limit,
    { order: "asc", includeNative: true, pages },
  );

  const built = Date.now();
  const trades = await buildTrades(tx.transfers);

  // Mark open positions with the price fomo already publishes per holding — free, and
  // the only current price available without a paid feed.
  const marks = new Map<string, number>();
  for (const h of t.holdings ?? []) {
    if (h.tokenAddress && typeof h.price === "number") {
      marks.set(h.tokenAddress.toLowerCase(), h.price);
    }
  }

  const { trades: settled, positions } = replay(trades, marks);
  const summary = summarise(settled, positions);

  const notes = [...r.evm.notes, ...r.solana.notes];
  if (evmAddr === null && r.evm.confidence !== "no-evm-holdings") {
    notes.push(`EVM not scanned — resolution was '${r.evm.confidence}'`);
  }
  if (solAddr === null && r.solana.confidence !== "no-sol-holdings") {
    notes.push(`Solana not scanned — resolution was '${r.solana.confidence}'`);
  }
  if (summary.coverage.sells_without_basis > 0) {
    notes.push(
      `${summary.coverage.sells_without_basis} sell(s) have no purchase inside the fetched ` +
      `window — raise ?pages= to reach further back, or accept them as unpriceable`,
    );
  }
  if (summary.coverage.positions_unmarked > 0) {
    notes.push(
      `${summary.coverage.positions_unmarked} open position(s) have no current price in the ` +
      `directory, so their unrealised PnL is excluded from the totals`,
    );
  }

  return {
    trader: { handle: t.handle, name: t.name, rank: t.rank },
    scanned_wallets: {
      evm: { address: evmAddr, confidence: r.evm.confidence, skipped: evmAddr === null },
      solana: { address: solAddr, confidence: r.solana.confidence, skipped: solAddr === null },
    },
    chains: tx.chains,
    summary,
    trades: settled,
    positions,
    notes,
    timings: {
      resolve_ms: r.cached ? 0 : r.elapsed_ms,
      resolve_cached: r.cached,
      fetch_ms: tx.elapsed_ms,
      price_and_replay_ms: Date.now() - built,
    },
    pulled_at: tx.pulled_at,
  };
}

/**
 * ENDPOINT 3 — transfers paired into trades, each with its own profit or loss.
 *
 * `?kind=buy,sell` filters, `?order=` sets display order only (the replay is always
 * oldest-first). A trade with `pnl_status: "unavailable"` is one we genuinely cannot
 * settle; the reason says why. Never read a null there as a zero.
 */
app.get("/v1/traders/:handle/trades", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const out = await analyse(t, req);

  const kinds = String(req.query.kind ?? "")
    .split(",").map((k) => k.trim()).filter(Boolean);
  let rows = kinds.length ? out.trades.filter((x) => kinds.includes(x.kind)) : out.trades;
  if (String(req.query.order ?? "desc") !== "asc") rows = [...rows].reverse();

  res.json({
    ...out,
    basis_method: out.summary.basis_method,
    count: rows.length,
    trades: rows,
    ...(String(req.query.include_positions ?? "") === "true" ? {} : { positions: undefined }),
  });
});

/** ENDPOINT 4 — the scorecard, without the trade list. */
app.get("/v1/traders/:handle/performance", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const out = await analyse(t, req);
  res.json({
    trader: out.trader,
    scanned_wallets: out.scanned_wallets,
    chains: out.chains,
    ...out.summary,
    /** What fomo claims, for contrast — computed above, reported here, never mixed. */
    fomo_reported_pnl_30d: t.pnl ?? null,
    positions: out.positions,
    notes: out.notes,
    timings: out.timings,
    pulled_at: out.pulled_at,
  });
});


/**
 * Hyperliquid leaderboard — the same `board` envelope as /v1/traders.
 *
 * No resolution step: Hyperliquid publishes `ethAddress` directly, so there is no
 * provisioned wallet to see through. `roi` is included because it is the honest measure —
 * absolute pnl flatters whoever deployed the most capital.
 *
 *   ?limit=2            first N rows (absent/invalid means the whole retained board)
 *   ?window=day|week|month|allTime   which performance window to rank by (default day)
 */
app.get("/v1/hyperliquid/traders", auth, async (req, res) => {
  const w = String(req.query.window ?? "day");
  if (!hyperliquid.isWindow(w)) {
    res.status(400).json({
      detail: `unknown window '${w}' — use one of ${hyperliquid.WINDOWS.join(", ")}`,
    });
    return;
  }

  let board;
  try {
    board = await hyperliquid.leaderboard();
  } catch (e) {
    res.status(502).json({
      detail: `hyperliquid leaderboard unavailable: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  const rows = board.byWindow.get(w) ?? [];
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? rows : rows.slice(0, limit);

  res.json({
    board: "hyperliquid",
    window: w,
    capturedAt: Math.floor(board.at / 1000),
    count: page.length,
    // `total` is every trader on the feed; `ranked` is what we retain per window.
    total: board.total,
    ranked: rows.length,
    entries: page.map((r, i) => ({
      rank: i + 1,
      address: r.address,
      label: r.label,
      accountValue: r.accountValue,
      pnl: r.pnl,
      roi: r.roi,
      volume: r.volume,
    })),
  });
});


/**
 * pump.fun leaderboard — same envelope as /v1/hyperliquid/traders.
 *
 * `Transaction.Signer` is the trader's wallet, so like Hyperliquid there is no resolution
 * step. Two fields exist here that the other boards do not need:
 *
 *   coverageFrom  how far back the data actually reaches. Our Bitquery plan only serves
 *                 the `realtime` dataset (~12h), so this is a "trading now" board rather
 *                 than a 7d/30d ranking. Stated rather than implied.
 *   minTrades     raw volume ranking surfaces wash trades and mispriced tokens — one
 *                 wallet showed 3 trades and $94M. Defaults to 10; ?minTrades=0 disables.
 */
app.get("/v1/pumpfun/traders", auth, async (req, res) => {
  let board;
  try {
    board = await pumpfun.leaderboard();
  } catch (e) {
    res.status(502).json({
      detail: `pumpfun leaderboard unavailable: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  const askedMin = Number(req.query.minTrades);
  const minTrades = Number.isFinite(askedMin) && askedMin >= 0 ? Math.floor(askedMin) : 10;
  const ranked = board.rows.filter((r) => r.trades >= minTrades);

  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? ranked : ranked.slice(0, limit);

  // Only the page gets profile lookups, so ?limit=2 costs two calls rather than 200.
  const profiles = await pumpfun.resolveProfiles(page.map((r) => r.address));

  res.json({
    board: "pumpfun",
    protocols: pumpfun.PROTOCOL_NAMES,
    coverageFrom: board.coverageFrom,
    capturedAt: Math.floor(board.at / 1000),
    count: page.length,
    ranked: ranked.length,
    total: board.rows.length,
    minTrades,
    entries: page.map((r, i) => {
      const p = profiles.get(r.address);
      return {
        rank: i + 1,
        address: r.address,
        label: p?.label ?? null,
        // pump.fun auto-assigns a handle to every wallet, so a label alone proves nothing.
        // `registered` is what says a human actually claimed the account.
        registered: p?.registered ?? false,
        followers: p?.followers ?? null,
        twitter: p?.twitter ?? null,
        volumeUsd: r.volumeUsd,
        trades: r.trades,
      };
    }),
  });
});


/**
 * gmgn.ai trader board — same envelope as the hyperliquid and pumpfun boards.
 *
 * The wallets come pre-curated by gmgn as smart money or KOLs, which is what makes this
 * board different in kind: our pump.fun board ranks raw volume and returns 183 bots out
 * of 200, whereas these are wallets someone has already classified as worth watching.
 * KOL rows also carry a real twitter identity rather than an auto-generated handle.
 *
 *   ?limit=2                 first N rows
 *   ?cohort=smartmoney|kol   which cohort to rank (default smartmoney)
 *   ?chain=sol               chain (default sol)
 */
app.get("/v1/gmgn/traders", auth, async (req, res) => {
  const cohort = String(req.query.cohort ?? "smartmoney");
  if (!gmgn.isCohort(cohort)) {
    res.status(400).json({
      detail: `unknown cohort '${cohort}' — use one of ${gmgn.COHORTS.join(", ")}`,
    });
    return;
  }
  const chain = String(req.query.chain ?? "sol");

  let board;
  try {
    board = await gmgn.leaderboard(chain);
  } catch (e) {
    res.status(502).json({
      detail: `gmgn leaderboard unavailable: ${e instanceof Error ? e.message : String(e)}`,
    });
    return;
  }

  const rows = board.byCohort.get(cohort) ?? [];
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? rows : rows.slice(0, limit);

  res.json({
    board: "gmgn",
    chain,
    cohort,
    capturedAt: Math.floor(board.at / 1000),
    count: page.length,
    ranked: rows.length,
    entries: page.map((r, i) => ({
      rank: i + 1,
      address: r.address,
      label: r.label,
      twitter: r.twitter,
      avatarUrl: r.avatar,
      tags: r.tags,
      volumeUsd: r.volumeUsd,
      trades: r.trades,
      buys: r.buys,
      sells: r.sells,
      lastSeen: r.lastSeen,
    })),
  });
});


/**
 * Per-trader routes for the three wallet-first platforms.
 *
 * The `:handle` segment is a WALLET ADDRESS, not a username. Unlike fomo — which
 * publishes a provisioned wallet and hides the real one, hence resolvers.ts — these
 * platforms use the address as the identity. Nothing is resolved here; a lookup is a
 * lookup. Hyperliquid additionally accepts a leaderboard displayName as a convenience,
 * since ~1,400 of its accounts set one.
 */

// ---------------------------------------------------------------- hyperliquid

app.get("/v1/hyperliquid/traders/:handle/wallets", auth, async (req, res) => {
  const askedW = Number(req.query.limit);
  const limit = Number.isFinite(askedW) && askedW >= 1 ? Math.floor(askedW) : null;
  try {
    const address = await hyperliquid.resolveHandle(req.params.handle);
    if (!address) {
      res.status(404).json({ detail: `no hyperliquid trader '${req.params.handle}'` });
      return;
    }
    res.json({
      platform: "hyperliquid",
      handle: req.params.handle,
      // The address IS the account: margin and positions live on Hyperliquid's own L1,
      // so this is not queryable through the EVM chains in settings.ts.
      address,
      chain: "hyperliquid-l1",
      // A big account can hold 30+ positions, so ?limit trims them the same way it does
      // everywhere else rather than dumping the lot.
      account: await hyperliquid.account(address, limit),
    });
  } catch (e) {
    res.status(502).json({ detail: `hyperliquid unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

app.get("/v1/hyperliquid/traders/:handle/transactions", auth, async (req, res) => {
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 2000) : 100;
  try {
    const address = await hyperliquid.resolveHandle(req.params.handle);
    if (!address) {
      res.status(404).json({ detail: `no hyperliquid trader '${req.params.handle}'` });
      return;
    }
    const rows = await hyperliquid.fills(address, limit);
    res.json({
      platform: "hyperliquid", handle: req.params.handle, address,
      count: rows.length, transactions: rows,
    });
  } catch (e) {
    res.status(502).json({ detail: `hyperliquid unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

// ------------------------------------------------------------------- pump.fun

app.get("/v1/pumpfun/traders/:handle/wallets", auth, async (req, res) => {
  try {
    const p = (await pumpfun.resolveProfiles([req.params.handle])).get(req.params.handle);
    res.json({
      platform: "pumpfun", handle: req.params.handle,
      // The resolved wallet, which is NOT the path param when a username was passed.
      address: p?.address ?? null,
      chain: "solana",
      label: p?.label ?? null,
      // pump.fun auto-assigns a handle to every wallet, so `registered` is what says a
      // human actually claimed it. Most high-volume wallets are bots and have neither.
      registered: p?.registered ?? false,
      followers: p?.followers ?? null,
      twitter: p?.twitter ?? null,
    });
  } catch (e) {
    res.status(502).json({ detail: `pumpfun unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

app.get("/v1/pumpfun/traders/:handle/transactions", auth, async (req, res) => {
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 100) : 50;
  try {
    const address = await pumpfun.resolveHandle(req.params.handle);
    if (!address) {
      res.status(404).json({ detail: `no pumpfun trader '${req.params.handle}'` });
      return;
    }
    const rows = await pumpfun.trades(address, limit);
    res.json({
      platform: "pumpfun", handle: req.params.handle, address,
      protocols: pumpfun.PROTOCOL_NAMES,
      // Bounded by Bitquery's ~12h realtime window — an empty list may mean "not trading
      // recently" rather than "never traded".
      count: rows.length, transactions: rows,
    });
  } catch (e) {
    res.status(502).json({ detail: `pumpfun unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

// ----------------------------------------------------------------------- gmgn

app.get("/v1/gmgn/traders/:handle/wallets", auth, async (req, res) => {
  const chain = String(req.query.chain ?? "sol");
  try {
    // Accepts a name (label or twitter) as well as an address — see gmgn.resolveHandle.
    const address = await gmgn.resolveHandle(req.params.handle, chain);
    if (!address) {
      res.status(404).json({
        detail: `no gmgn trader '${req.params.handle}' — pass a wallet address, or a `
          + `label/twitter of a wallet currently on a cohort board`,
      });
      return;
    }
    // wallet_stats is the only endpoint across all four platforms that returns realized
    // PnL already computed, so it is the wallet view rather than a bare identity echo.
    const [stats, ident] = await Promise.all([
      gmgn.walletStats(address, chain, String(req.query.period ?? "7d")),
      gmgn.profile(address, chain).catch(() => null),
    ]);
    res.json({
      platform: "gmgn", handle: req.params.handle, address, chain,
      label: ident?.label ?? null,
      twitter: ident?.twitter ?? null,
      tags: ident?.tags ?? [],
      stats,
    });
  } catch (e) {
    res.status(502).json({ detail: `gmgn unavailable: ${e instanceof Error ? e.message : e}` });
  }
});

app.get("/v1/gmgn/traders/:handle/transactions", auth, async (req, res) => {
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 100) : 50;
  const chain = String(req.query.chain ?? "sol");
  try {
    const address = await gmgn.resolveHandle(req.params.handle, chain);
    if (!address) {
      res.status(404).json({ detail: `no gmgn trader '${req.params.handle}'` });
      return;
    }
    const rows = await gmgn.walletActivity(address, chain, limit);
    res.json({
      platform: "gmgn", handle: req.params.handle, address, chain,
      count: rows.length, transactions: rows,
    });
  } catch (e) {
    res.status(502).json({ detail: `gmgn unavailable: ${e instanceof Error ? e.message : e}` });
  }
});


/**
 * PARAMETERS.md T11 + T13 — position count and concentration.
 *
 * Computed entirely from the directory snapshot: no API call, no key, no rate limit. The
 * two ship together by rule, because position count alone inverts the truth — `unipcs`
 * holds 95 coins with 97% of the money in one of them, and "95 positions" reads as
 * diversified to anyone who does not check.
 *
 * `coverage` is not decoration: ~22% of rows in the snapshot carry no price, and a share
 * quoted without saying what it covers is the quiet way to mislead.
 */
app.get("/v1/traders/:handle/portfolio", auth, (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  res.json({ handle: t.handle, name: t.name ?? null, ...portfolio(t) });
});


/**
 * PARAMETERS.md K1 + K4 — which tokens the leaders are crowding into, and who holds them.
 *
 * Computed by inverting the snapshot's `holdings[]`; no API call. Quote assets (USDC, USDT,
 * wrapped natives) are excluded and that is not a preference — 85 of 100 leaders hold USDC,
 * so leaving them in makes the top of the board the currency rather than a trade.
 *
 * Crowding is reported, never recommended. 34 of 150 traders once held the same honeypot:
 * consensus can mean a good call or a coordinated pump, and this number cannot tell them
 * apart.
 *
 *   ?limit=10        page size (absent = whole board)
 *   ?minHolders=2    drop tokens only one leader holds (default 1)
 *   ?chain=solana    filter to one chain
 */
app.get("/v1/tokens", auth, (req, res) => {
  const meta = directory.meta();
  const traders = directory.all();

  const chainQ = String(req.query.chain ?? "").trim().toLowerCase();
  let chain: number | null = null;
  if (chainQ) {
    const hit = [SOLANA_NETWORK_ID, ...Object.keys(EVM_CHAINS).map(Number)]
      .find((id) => chainName(id) === chainQ);
    if (hit === undefined) {
      res.status(400).json({ detail: `unknown chain '${chainQ}'` });
      return;
    }
    chain = hit;
  }

  const askedMin = Number(req.query.minHolders);
  const minHolders = Number.isFinite(askedMin) && askedMin >= 1 ? Math.floor(askedMin) : 1;
  const { rows, totalTokens, excluded, traderCount } = tokenBoard(traders, { chain, minHolders });

  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? rows : rows.slice(0, limit);

  res.json({
    board: "tokens",
    chain: chainQ || "all",
    capturedAt: meta.generated_at ?? null,
    traders: traderCount,
    count: page.length,
    ranked: rows.length,
    totalTokens,
    minHolders,
    /**
     * Stablecoins and wrapped natives dropped before ranking — the currency, not a trade.
     * `tokens` is how many distinct assets were dropped; `positions` is how many holding
     * rows they covered. Measured: 5 assets across 157 positions.
     */
    excludedQuoteAssets: excluded,
    entries: page.map((r, i) => ({ rank: i + 1, ...r })),
  });
});


/**
 * PARAMETERS.md T1 — banked versus on paper.
 *
 * The spine of the trust model. A profit that is entirely unrealised may be a honeypot
 * mark: the measured case was $95,577,723 of "profit" on $41 of volume, cost basis $9.87,
 * in a token nobody had ever sold. Realized and unrealised are never merged into one
 * "profit" figure here.
 *
 * Costs one fomoapi call per trader (cached 10 min). fomoapi serves trades live and reports
 * its own unavailability — that is passed through as `available` rather than being rendered
 * as a zero.
 */
app.get("/v1/traders/:handle/pnl", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  if (!haveFomoapi()) {
    res.status(503).json({ detail: "FOMOAPI_KEY is not set — T1 needs fomoapi /trades" });
    return;
  }
  try {
    const b = await banked(t.handle);
    if (!b) {
      res.status(404).json({ detail: `fomoapi has no trades for '${t.handle}'` });
      return;
    }
    res.json({ handle: t.handle, name: t.name ?? null, source: "fomoapi /v2/users/{handle}/trades", ...b });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({
      detail: /timed out|abort/i.test(msg)
        ? "fomoapi /trades did not respond in time — it serves trades live and is currently slow"
        : `fomoapi unavailable: ${msg}`,
    });
  }
});


/** PARAMETERS.md T12 — what a trader actually holds, biggest position first.
 *
 *  Unpriced positions are returned, not dropped: they are real holdings we simply cannot
 *  value, and hiding them would misstate the position count. They sort last with
 *  `valueUsd: null` — never 0, which would imply we checked and found nothing.
 *
 *    ?limit=10           page size (absent = all)
 *    ?includeQuote=false drop stablecoins/wrapped natives from the list
 */
app.get("/v1/traders/:handle/positions", auth, (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const { rows, totalValueUsd } = positions(t);
  const filtered = String(req.query.includeQuote ?? "") === "false"
    ? rows.filter((r) => !r.isQuoteAsset)
    : rows;
  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? filtered : filtered.slice(0, limit);
  const priced = rows.filter((r) => r.valueUsd !== null).length;

  res.json({
    handle: t.handle,
    name: t.name ?? null,
    count: page.length,
    positions: filtered.length,
    totalValueUsd,
    coverage: { pricedPositions: priced, unpricedPositions: rows.length - priced },
    entries: page,
  });
});

/**
 * PARAMETERS.md K2 — what the leaders moved into and out of since the last snapshot.
 *
 * Registered BEFORE /v1/tokens/:address deliberately: Express matches in order, and a
 * literal path declared after a parameterised sibling of the same shape is unreachable.
 *
 * This is the one parameter that cannot be computed from the current file, because "what
 * changed" is not a property of a single snapshot. When only one snapshot exists the route
 * returns `available: false` rather than an empty board — "nothing moved" and "we have no
 * baseline" are different answers and must not render identically.
 *
 *   ?limit=20      page size (absent = every token that moved)
 *   ?direction=in  only gainers (`in`) or only losers (`out`)
 */
app.get("/v1/tokens/momentum", auth, (req, res) => {
  const m = snapshots.momentum();
  const dir = String(req.query.direction ?? "").trim().toLowerCase();
  let rows = m.rows;
  if (dir === "in") rows = rows.filter((r) => r.change > 0);
  else if (dir === "out") rows = rows.filter((r) => r.change < 0);
  else if (dir) {
    res.status(400).json({ detail: `unknown direction '${dir}' — use 'in' or 'out'` });
    return;
  }

  const asked = Number(req.query.limit);
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
  const page = limit === null ? rows : rows.slice(0, limit);

  res.status(m.available ? 200 : 200).json({
    board: "momentum",
    available: m.available,
    snapshots: m.snapshots,
    from: m.from,
    to: m.to,
    spanHours: m.spanHours,
    direction: dir || "all",
    moved: rows.length,
    count: page.length,
    entries: page,
    plain: m.plain,
  });
});


/** PARAMETERS.md K1/K3/K4/C5 for a single token — the drill-down from /v1/tokens.
 *
 *  A token address can exist on more than one chain, so without `?chain=` every match is
 *  returned rather than one being picked silently.
 */
app.get("/v1/tokens/:address", auth, (req, res) => {
  const chainQ = String(req.query.chain ?? "").trim().toLowerCase();
  let networkId: number | null = null;
  if (chainQ) {
    const hit = [SOLANA_NETWORK_ID, ...Object.keys(EVM_CHAINS).map(Number)]
      .find((id) => chainName(id) === chainQ);
    if (hit === undefined) {
      res.status(400).json({ detail: `unknown chain '${chainQ}'` });
      return;
    }
    networkId = hit;
  }
  const matches = tokenDetail(directory.all(), req.params.address, networkId);
  if (!matches.length) {
    res.status(404).json({ detail: `no leader holds '${req.params.address}'${chainQ ? ` on ${chainQ}` : ""}` });
    return;
  }
  res.json({
    tokenAddress: req.params.address,
    capturedAt: directory.meta().generated_at ?? null,
    chains: matches.length,
    entries: matches,
  });
});

/** PARAMETERS.md trust flags — plausibility of a trader's own reported numbers.
 *
 *  Pure file arithmetic. Exists because the leaderboard's figures frequently fail their own
 *  arithmetic: measured on this snapshot, 45 of 100 traders claim a profit larger than
 *  their entire lifetime volume, and 64 of 100 claim more than 10x everything they hold.
 *
 *  These are plausibility checks, not fraud findings — a flag means the number cannot be
 *  corroborated from the data we hold, not that anyone acted in bad faith.
 */
app.get("/v1/traders/:handle/trust", auth, (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  res.json({ handle: t.handle, name: t.name ?? null, reportedPnlUsd: t.pnl ?? null, volumeUsd: t.volume ?? null, ...trust(t) });
});

/**
 * PARAMETERS.md C1 + C2 + C4 + C5 — where the leaderboard actually trades.
 *
 * Pure file arithmetic for C1/C2; C4 and C5 describe OUR state rather than the traders',
 * which is the point of the section. What we can see differs by chain, and that constrains
 * every other parameter in this API: position sizes are verifiable everywhere via a free
 * `balanceOf`, but transaction history is not — on BSC and Base it needs a paid provider,
 * so a trader who looks quiet there may simply be invisible to us.
 *
 * C3 (chain profitability) is deliberately absent: the snapshot carries one `pnl` per
 * trader, not one per chain, so splitting it would mean inventing an attribution.
 */
app.get("/v1/chains", auth, (req, res) => {
  const { rows, traderCount, totalPositions } = chainBoard(directory.all());

  // C4 — coverage is a fact about our own credentials, so it is reported, not guessed.
  const history = (networkId: number): { available: boolean; via: string | null; note: string | null } => {
    if (networkId === SOLANA_NETWORK_ID) {
      if (haveHelius()) return { available: true, via: "helius", note: null };
      if (haveBitquery()) return { available: true, via: "bitquery", note: null };
      return { available: false, via: null, note: "needs HELIUS_API_KEY or BITQUERY_TOKEN" };
    }
    const chain = EVM_CHAINS[networkId];
    if (chain?.blockscout) return { available: true, via: "blockscout", note: "keyless" };
    if (networkId === 1 && haveEtherscan()) return { available: true, via: "etherscan", note: null };
    if (haveBitquery()) return { available: true, via: "bitquery", note: null };
    return { available: false, via: null, note: "no free history provider for this chain" };
  };

  res.json({
    board: "chains",
    capturedAt: directory.meta().generated_at ?? null,
    traders: traderCount,
    totalPositions,
    count: rows.length,
    entries: rows.map((r) => ({
      ...r,
      // C4
      historyCoverage: history(r.networkId),
      // C5 — true on every chain we index, and worth stating: it means a position SIZE is
      // always checkable even where the trade history behind it is not.
      balanceVerifiable: true,
    })),
    plain:
      rows.length
        ? `${rows[0].traders} of ${traderCount} leaders trade ${rows[0].chain}, which carries ` +
          `${rows[0].positions} of ${totalPositions} positions on the board.`
        : "No positions in the directory.",
  });
});


/**
 * PARAMETERS.md T2, T3, T5-T10, T15-T20 — the full scorecard.
 *
 * Costs NO additional API call: it reads the same `/trades` document `/pnl` already
 * fetches and caches for 10 minutes. That is why fourteen parameters could ship at once.
 *
 * Read the `coverage` objects before the numbers. fomo carries entry and exit prices on a
 * minority of trades — measured on `unipcs`, 21 of 184 have an entry price and 2 of 25
 * closed trades have both — so every price-derived figure here (money in/out, return %,
 * typical bet size) states what it was computed over, and returns null rather than a
 * confident number drawn from a handful of rows.
 *
 *   ?tokens=10   trim the per-token breakdown (absent = every token)
 */
app.get("/v1/traders/:handle/scorecard", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  if (!haveFomoapi()) {
    res.status(503).json({ detail: "FOMOAPI_KEY is not set — the scorecard needs fomoapi /trades" });
    return;
  }
  try {
    const s = await scorecard(t.handle, { volume: t.volume ?? null, trades: t.trades ?? null });
    if (!s) {
      res.status(404).json({ detail: `fomoapi has no trades for '${t.handle}'` });
      return;
    }
    const asked = Number(req.query.tokens);
    const limit = Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : null;
    res.json({
      handle: t.handle,
      name: t.name ?? null,
      source: "fomoapi /v2/users/{handle}/trades",
      ...s,
      tokensReturned: limit === null ? s.byToken.length : Math.min(limit, s.byToken.length),
      tokensTotal: s.byToken.length,
      byToken: limit === null ? s.byToken : s.byToken.slice(0, limit),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({
      detail: /timed out|abort/i.test(msg)
        ? "fomoapi /trades did not respond in time — it serves trades live and is currently slow"
        : `fomoapi unavailable: ${msg}`,
    });
  }
});


/**
 * PARAMETERS.md K5, K6, K7, K8 — what the holders of a token have actually DONE with it.
 *
 * `/v1/tokens/:address` answers who holds it. This answers whether anyone ever got OUT,
 * which is the sharper question: a token every leader holds and nobody has ever sold is
 * the shape of a honeypot, and a holder count cannot tell that apart from a good call.
 *
 * Costs one fomoapi call per sampled holder, capped (default 25) and cached 10 minutes
 * alongside /pnl and /scorecard. The cap is a budget, not a page size — the free tier is
 * 10,000 calls a month, and an uncapped board-wide version would spend that in a day.
 *
 *   ?chain=solana   disambiguate a token address that exists on more than one chain
 *   ?holders=10     lower the sample (and the cost); 25 max
 */
app.get("/v1/tokens/:address/activity", auth, async (req, res) => {
  if (!haveFomoapi()) {
    res.status(503).json({ detail: "FOMOAPI_KEY is not set — K5-K8 need fomoapi /trades" });
    return;
  }
  const chainQ = String(req.query.chain ?? "").trim().toLowerCase();
  let networkId: number | null = null;
  if (chainQ) {
    const hit = [SOLANA_NETWORK_ID, ...Object.keys(EVM_CHAINS).map(Number)]
      .find((id) => chainName(id) === chainQ);
    if (hit === undefined) {
      res.status(400).json({ detail: `unknown chain '${chainQ}'` });
      return;
    }
    networkId = hit;
  }

  const matches = tokenDetail(directory.all(), req.params.address, networkId);
  if (!matches.length) {
    res.status(404).json({ detail: `no leader holds '${req.params.address}'${chainQ ? ` on ${chainQ}` : ""}` });
    return;
  }
  if (matches.length > 1) {
    res.status(400).json({
      detail: `'${req.params.address}' exists on ${matches.length} chains — pass ?chain= to pick one`,
      chains: matches.map((m) => m.chain),
    });
    return;
  }

  const asked = Number(req.query.holders);
  const cap = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 25) : 25;
  try {
    const act = await tokenActivity(matches[0].holderHandles, matches[0].tokenAddress, cap);
    res.json({
      chain: matches[0].chain,
      networkId: matches[0].networkId,
      holdersInDirectory: matches[0].holders,
      totalValueUsd: matches[0].totalValueUsd,
      source: "fomoapi /v2/users/{handle}/trades",
      ...act,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(502).json({ detail: `fomoapi unavailable: ${msg}` });
  }
});


/**
 * Snapshot archive state — the substrate K2 runs on.
 *
 * POST writes the current directory build to the archive if it is not already there,
 * keyed on the file's own `generated_at` so restarting the server does not manufacture
 * duplicate snapshots and a momentum of zero.
 */
app.get("/v1/snapshots", auth, (_req, res) => {
  const m = snapshots.momentum();
  res.json({
    snapshots: m.snapshots,
    comparable: m.available,
    from: m.from,
    to: m.to,
    note: "archive lives on the instance filesystem; on an ephemeral host it resets on redeploy",
  });
});

app.post("/v1/snapshots", auth, (_req, res) => {
  res.json(snapshots.archive());
});


app.use((_req, res) => res.status(404).json({ detail: "not found" }));

const server = app.listen(PORT, () => {
  console.log(`genie-fomo API (typescript) on port ${PORT}`);
  console.log(`  directory: ${directory.meta().traders} traders`);
  // Archive on boot so K2 starts accruing without anyone remembering to call it. Keyed on
  // the directory's own timestamp, so repeated restarts do not stack identical snapshots.
  try {
    const a = snapshots.archive();
    console.log(`  snapshots: ${a.total} archived${a.written ? ` (wrote ${a.file})` : ""}`);
  } catch (e) {
    console.log(`  snapshots: archive failed — ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`  auth: ${API_KEY ? "X-API-Key required" : "none (open access)"}`);
  console.log(`  cors: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(", ") : "any origin"}`);
});

// Platforms send SIGTERM on deploy/scale-down; finish in-flight requests first.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
