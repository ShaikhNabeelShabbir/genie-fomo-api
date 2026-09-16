import type { Env } from "./env";
import { webhook } from "./webhook";
import { sample, sampleSlice } from "./sampler";
import { api } from "./api";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" && req.method === "GET") return Response.json({ ok: true, worker: "genie-copy-trading-api" });
    if (pathname === "/webhook") return webhook(req, env, ctx);
    if (pathname === "/sample") return sample(req, env);
    return api(req, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (!env.HYPERDRIVE) { console.log("sampler: HYPERDRIVE binding is parked, nothing to do"); return; }
    // `await`, not `ctx.waitUntil`: a slice that throws should show up as a failed cron
    // invocation in the dashboard, not as a silently dropped promise. See docs/CLOUDFLARE_MIGRATION.md §7
    const { sampled, refused, stoppedEarly, pendingThisHour } = await sampleSlice(env, { limit: 10 });
    console.log("sampler:", { sampled, refused, stoppedEarly, pendingThisHour });
  },
} satisfies ExportedHandler<Env>;
