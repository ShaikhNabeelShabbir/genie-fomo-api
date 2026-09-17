import type { Env } from "./env";
import { webhook } from "./webhook";
import { sample } from "./sampler";
import { api } from "./api";
import { runPrices } from "./jobs/prices";
import { runScorecards } from "./jobs/scorecards";
import { runAumHistory } from "./jobs/aum_history";
import { runTokens } from "./jobs/tokens";
import { runLaunches } from "./jobs/launches";
import { runTransfers } from "./jobs/transfers";
import { runWallets } from "./jobs/wallets";
import { runQuotePrices } from "./jobs/quote_prices";
import { runBalances } from "./jobs/balances";
import { runFees } from "./jobs/fees";
import { runTiming } from "./jobs/timing";
import { runSwaps } from "./jobs/swaps";

/**
 * Every job is a sliced, resumable loader (worker/src/jobs/*). The strings must match
 * [triggers] crons in wrangler.toml character for character; index.ts dispatches on them.
 * Staggered so no two heavy jobs share a minute; each stops on its own before JOB_BUDGET_MS.
 */
const JOBS: Readonly<Record<string, (env: Env, budgetMs: number) => Promise<unknown>>> = {
  "17 * * * *":   runPrices,       // hourly token prices (DexScreener) -> token_price_hourly
  "25 * * * *":   runAumHistory,   // after prices: build every trader-hour not yet built
  "40 * * * *":   runTransfers,    // on-chain transfers, stalest wallet first; Helius watch list
  "45 * * * *":   runQuotePrices,  // quote-asset transfer pricing; Robinhood-chain coins
  "*/10 * * * *": runBalances,     // a slice of the stalest wallets' balances -> holdings
  "5 */2 * * *":  runTokens,       // chains, supply, fundamentals (GMGN 1 req/s)
  "10 */2 * * *": runFees,         // receipts per chain, then the per-trader rollup
  "20 */3 * * *": runSwaps,        // EVM swaps from receipts
  "0 */6 * * *":  runScorecards,   // stale fomoapi trade records
  "35 3 * * *":   runLaunches,     // pump.fun launch metadata, dev ledger
  "50 4 * * *":   runWallets,      // linked wallets
  "55 5 * * *":   runTiming,       // position timing (one aggregate)
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" && req.method === "GET") return Response.json({ ok: true, worker: "genie-copy-trading-api" });
    if (pathname === "/webhook") return webhook(req, env, ctx);
    if (pathname === "/sample") return sample(req, env);
    return api(req, env, ctx);
  },

  /**
   * One Worker, three crons; `event.cron` says which fired (worker/wrangler.toml [triggers]).
   * `await`, not `ctx.waitUntil`: a job that throws shows as a failed cron invocation in the
   * dashboard, not as a silently dropped promise. See docs/CLOUDFLARE_MIGRATION.md §7
   */
  /**
   * `await`, not `ctx.waitUntil`: a job that throws shows as a failed cron invocation in the
   * dashboard, not as a silently dropped promise. See docs/CLOUDFLARE_MIGRATION.md §7
   */
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.HYPERDRIVE) { console.log("cron: HYPERDRIVE binding is parked, nothing to do"); return; }
    const job = JOBS[event.cron];
    if (!job) throw new Error(`no job for cron '${event.cron}'`);
    const budgetMs = Number(env.JOB_BUDGET_MS ?? 600_000);
    console.log(`${job.name}:`, await job(env, budgetMs));
  },
} satisfies ExportedHandler<Env>;
