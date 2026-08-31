import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";

import * as directory from "./directory.js";
import type { Trader } from "./directory.js";
import { resolveAll } from "./resolvers.js";
import { fetchTransactions } from "./transactions.js";
import {
  API_KEY, CORS_ORIGINS, PORT, haveBitquery, haveEtherscan, haveHelius,
} from "./settings.js";

/**
 * genie-fomo REST API (TypeScript).
 *
 *   GET /v1/traders/{handle}/wallets       username -> the wallets they actually trade from
 *   GET /v1/traders/{handle}/transactions  those wallets -> their live transactions
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
 * Always returns the confidence and the evidence: `confirmed` (two independent tokens
 * agreed) and `high-candidate` (one tight, unrivalled match) are not interchangeable.
 */
app.get("/v1/traders/:handle/wallets", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }
  const r = await resolveAll(t);
  res.json({
    trader: publicTrader(t),
    resolved_wallets: { evm: r.evm, solana: r.solana },
    elapsed_ms: r.elapsed_ms,
  });
});

/**
 * ENDPOINT 2 — the resolved wallets' live transactions.
 * Read `chains[]` before trusting an empty list: `count: 0, error: null` means no
 * activity, while `count: 0, error: "..."` means that chain could not be reached.
 */
app.get("/v1/traders/:handle/transactions", auth, async (req, res) => {
  const t = directory.get(req.params.handle);
  if (!t) {
    res.status(404).json({ detail: `no trader '${req.params.handle}' in the directory` });
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 300);
  const side = String(req.query.side ?? "");
  const includeEvidence = String(req.query.include_evidence ?? "") === "true";
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

  const scanned: Record<string, unknown> = {
    evm: {
      address: evmAddr, confidence: evm.confidence, method: evm.method,
      skipped: evmAddr === null,
      ...(includeEvidence ? { matches: evm.matches } : {}),
    },
    solana: {
      address: solAddr, confidence: solana.confidence,
      skipped: solAddr === null,
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
    transfers: rows,
    notes,
    resolve_ms: r.elapsed_ms,
    fetch_ms: tx.elapsed_ms,
    pulled_at: tx.pulled_at,
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
