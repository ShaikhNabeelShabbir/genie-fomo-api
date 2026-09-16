import type { Env } from "./env";
import { webhook } from "./webhook";

const notPorted = (section: string): Response =>
  Response.json({ error: "not_ported", see: `docs/CLOUDFLARE_MIGRATION.md ${section}` }, { status: 501 });

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" && req.method === "GET") return Response.json({ ok: true, worker: "genie-fomo" });
    if (pathname === "/webhook") return webhook(req, env, ctx);
    if (pathname === "/sample") return notPorted("§7");
    return notPorted("§5");
  },

  async scheduled(_event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("sampler not ported yet");
  },
} satisfies ExportedHandler<Env>;
