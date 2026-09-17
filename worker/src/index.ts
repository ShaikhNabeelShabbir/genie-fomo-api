import type { Env } from "./env";
import { webhook } from "./webhook";
import { sample } from "./sampler";
import { api } from "./api";
import { runPrices } from "./jobs/prices";
import { runScorecards } from "./jobs/scorecards";
import { runAumHistory } from "./jobs/aum_history";

/** Must match [triggers] crons in wrangler.toml, character for character. */
const CRON_PRICES = "17 * * * *";
const CRON_SCORECARDS = "0 */6 * * *";
/** After prices (:17): every trader-hour not yet built, always redoing the last two. */
const CRON_AUM_HISTORY = "25 * * * *";

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
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.HYPERDRIVE) { console.log("cron: HYPERDRIVE binding is parked, nothing to do"); return; }
    const budgetMs = Number(env.JOB_BUDGET_MS ?? 600_000);
    switch (event.cron) {
      case CRON_PRICES: { console.log("prices:", await runPrices(env, budgetMs)); return; }
      case CRON_SCORECARDS: { console.log("scorecards:", await runScorecards(env, budgetMs)); return; }
      case CRON_AUM_HISTORY: { console.log("aum_history:", await runAumHistory(env, budgetMs)); return; }
      default: throw new Error(`no job for cron '${event.cron}'`);
    }
  },
} satisfies ExportedHandler<Env>;
