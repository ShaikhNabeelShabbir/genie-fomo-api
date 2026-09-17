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
import { runGmgn } from "./jobs/gmgn";
import { runDirectory } from "./jobs/directory";
import { runAumLiveFlush } from "./jobs/aum_live_flush";

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
  "*/30 * * * *": runBalances,   // brake 17 Sep 08:57: a 10 min cadence overlapped its own 9 min runs     // a slice of the stalest wallets' balances -> holdings
  "5 */2 * * *":  runTokens,       // chains, supply, fundamentals (GMGN 1 req/s)
  "10 */2 * * *": runFees,         // receipts per chain, then the per-trader rollup
  "15,45 * * * *": runSwaps,        // Solana + EVM swaps, newest first (X1); budget-bounded so overlap is safe
  "0 */6 * * *":  runScorecards,   // stale fomoapi trade records
  "35 3 * * *":   runLaunches,     // pump.fun launch metadata, dev ledger
  "50 4 * * *":   runWallets,      // linked wallets
  "55 5 * * *":   runTiming,       // position timing (one aggregate)
  "15 2 * * *":   runGmgn,         // GMGN directory and its trades
  "0 1 * * *":    runDirectory,    // fomo leaderboard, wallets, fomo-reported holdings
  "*/5 * * * *":  runAumLiveFlush, // live value for traders whose wallet moved in the last minute
};

/** On-demand runs of the same jobs: `POST /jobs/<name>?budgetMs=&handles=&from=` with `x-job-secret`; only aum_history reads `handles`/`from`. */
interface JobOptions { readonly handles?: readonly string[]; readonly from?: Date }
const JOB_BY_NAME: Readonly<Record<string, (env: Env, budgetMs: number, opts: JobOptions) => Promise<unknown>>> = {
  prices: runPrices, aum_history: runAumHistory, transfers: runTransfers, quote_prices: runQuotePrices,
  balances: runBalances, tokens: runTokens, fees: runFees, swaps: runSwaps, scorecards: runScorecards,
  launches: runLaunches, wallets: runWallets, timing: runTiming, gmgn: runGmgn, directory: runDirectory,
  aum_live_flush: runAumLiveFlush,
};
const MAX_BUDGET_MS = 600_000;

async function runJob(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  if (!env.JOB_SECRET) return Response.json({ error: "JOB_SECRET is not set; refusing to run" }, { status: 503 });
  if (req.headers.get("x-job-secret") !== env.JOB_SECRET) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!env.DB) return Response.json({ error: "the D1 binding DB is not configured" }, { status: 503 });
  const url = new URL(req.url);
  const name = url.pathname.slice("/jobs/".length);
  const job = JOB_BY_NAME[name];
  if (!job) return Response.json({ error: `no job '${name}'`, jobs: Object.keys(JOB_BY_NAME) }, { status: 404 });
  const asked = Number(url.searchParams.get("budgetMs") ?? env.JOB_BUDGET_MS ?? MAX_BUDGET_MS);
  const budgetMs = Math.min(MAX_BUDGET_MS, Number.isFinite(asked) && asked > 0 ? asked : MAX_BUDGET_MS);
  const handles = url.searchParams.get("handles")?.split(",").map((h) => h.trim()).filter(Boolean);
  const fromRaw = url.searchParams.get("from");
  const from = fromRaw ? new Date(fromRaw) : undefined;
  if (from && Number.isNaN(from.getTime())) return Response.json({ error: "from must be ISO-8601" }, { status: 400 });
  try { return Response.json({ job: name, budgetMs, summary: await job(env, budgetMs, { handles, from }) }); }
  catch (e) { return Response.json({ job: name, error: e instanceof Error ? e.message : String(e) }, { status: 500 }); }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" && req.method === "GET") return Response.json({ ok: true, worker: "genie-copy-trading-api" });
    if (pathname === "/webhook") return webhook(req, env, ctx);
    if (pathname === "/sample") return sample(req, env);
    if (pathname.startsWith("/jobs/")) return runJob(req, env);
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
    if (!env.DB) { console.log("cron: the D1 binding DB is not configured, nothing to do"); return; }
    const job = JOBS[event.cron];
    if (!job) throw new Error(`no job for cron '${event.cron}'`);
    const budgetMs = Number(env.JOB_BUDGET_MS ?? 600_000);
    console.log(`${job.name}:`, await job(env, budgetMs));
  },
} satisfies ExportedHandler<Env>;
