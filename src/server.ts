import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";

import * as directory from "./directory.js";
import type { Trader } from "./directory.js";
import { resolveAll } from "./resolvers.js";
import type { Resolution } from "./resolvers.js";
import { fetchTransactions } from "./transactions.js";
import { buildTrades, replay, summarise } from "./pnl.js";
import { asQuote } from "./prices.js";
import type { Transfer } from "./transactions.js";
import {
  API_KEY, CORS_ORIGINS, PORT, haveBitquery, haveEtherscan, haveHelius,
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

app.get("/v1/traders", auth, (req, res) => {
  const q = String(req.query.q ?? "");
  const limit = Math.min(Math.max(Number(req.query.limit ?? 25) || 25, 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  const { rows, total } = directory.search(q, limit, offset);
  res.json({
    total,
    limit,
    offset,
    traders: rows.map((t) => ({
      handle: t.handle,
      name: t.name,
      rank: t.rank,
      pnl_30d: t.pnl,
      holdings: (t.holdings ?? []).length,
    })),
  });
});

/**
 * ENDPOINT 1 — username to the wallets they actually trade from.
 *
 * Returns just the addresses and how much to trust them. `confidence` ships even in the
 * slim shape on purpose: `confirmed` (two independent tokens agreed) and `high-candidate`
 * (one tight, unrivalled match) are safe to act on, anything else is a guess the service
 * itself will not scan. An address without it reads as a fact when it is not one.
 *
 * `?verbose=true` returns the full trader profile, per-match evidence and provider notes —
 * the shape this endpoint used to return by default, kept for debugging a resolution.
 */
app.get("/v1/traders/:handle/wallets", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const r = await resolveAll(t);

  if (String(req.query.verbose ?? "") === "true") {
    res.json({
      trader: publicTrader(t),
      resolved_wallets: { evm: r.evm, solana: r.solana },
      elapsed_ms: r.elapsed_ms,
    });
    return;
  }

  res.json({
    handle: t.handle,
    evm: { address: r.evm.address, confidence: r.evm.confidence },
    solana: { address: r.solana.address, confidence: r.solana.confidence },
  });
});

/**
 * ENDPOINT 2 — the resolved wallets' live transactions.
 * Read `chains[]` before trusting an empty list: `count: 0, error: null` means no
 * activity, while `count: 0, error: "..."` means that chain could not be reached.
 *
 * Slim by default; `?verbose=true` returns the full row this used to emit. What the slim
 * shape drops is duplication rather than information — see `slimTransfer`.
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

  const r = await resolveAll(t);
  const { evm, solana } = r;

  // Only scan an address we actually trust. A weak match would attribute someone else's
  // transactions to this trader, which is worse than returning nothing.
  const usable = new Set(["confirmed", "high-candidate"]);
  const evmAddr = usable.has(evm.confidence) ? evm.address : null;
  const solAddr = usable.has(solana.confidence) ? solana.address : null;

  const tx = await fetchTransactions(evmAddr, solAddr, wanted.length ? wanted : null, limit);
  const rows = side === "in" || side === "out"
    ? tx.transfers.filter((x) => x.side === side)
    : tx.transfers;

  // `confidence` stays even when slim: an address without it reads as a fact when it is
  // a probabilistic match. `skipped` is dropped because `address: null` already says so.
  const scanned: Record<string, unknown> = {
    evm: {
      address: evmAddr, confidence: evm.confidence,
      ...(verbose ? { method: evm.method, skipped: evmAddr === null } : {}),
      ...(includeEvidence ? { matches: evm.matches } : {}),
    },
    solana: {
      address: solAddr, confidence: solana.confidence,
      ...(verbose ? { skipped: solAddr === null } : {}),
      ...(includeEvidence ? { matches: solana.matches } : {}),
    },
  };

  const notes = [...evm.notes, ...solana.notes];
  if (evmAddr === null && evm.confidence !== "no-evm-holdings") {
    notes.push(`EVM not scanned — resolution was '${evm.confidence}'`);
  }
  if (solAddr === null && solana.confidence !== "no-sol-holdings") {
    notes.push(`Solana not scanned — resolution was '${solana.confidence}'`);
  }

  res.json({
    trader: { handle: t.handle, name: t.name, rank: t.rank },
    scanned_wallets: scanned,
    chains: tx.chains,
    count: rows.length,
    transfers: verbose ? rows : rows.map(slimTransfer),
    notes,
    // Timings are diagnostics, not part of the answer.
    ...(verbose
      ? { resolve_ms: r.elapsed_ms, fetch_ms: tx.elapsed_ms, pulled_at: tx.pulled_at }
      : {}),
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
  const value = await resolveAll(t);
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

app.use((_req, res) => res.status(404).json({ detail: "not found" }));

const server = app.listen(PORT, () => {
  console.log(`genie-fomo API (typescript) on port ${PORT}`);
  console.log(`  directory: ${directory.meta().traders} traders`);
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
