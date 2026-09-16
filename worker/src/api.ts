import type { Env } from "./env";
import { db } from "./db";
import { handle } from "../../supabase/functions/api/app.ts";
import { runWith } from "../../supabase/functions/api/db.ts";

/**
 * /v1/* on Workers: the SAME api modules as the Deno function. A client per request (§4.3),
 * handed to `db.ts`'s AsyncLocalStorage store together with the Worker env so every
 * `sql\`…\`` and `cfg()` inside `handle` resolves to this request's. See docs/CLOUDFLARE_MIGRATION.md §5.2
 */
export async function api(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.HYPERDRIVE) {
    return Response.json({ error: "not_configured", detail: "HYPERDRIVE binding is parked" }, { status: 503 });
  }
  const sql = db(env);
  // The store carries string vars only; the binding stays on `env` for `db()`.
  const { HYPERDRIVE: _binding, ...vars } = env;
  try {
    return await runWith({ sql, env: vars }, () => handle(req));
  } finally {
    ctx.waitUntil(sql.end({ timeout: 5 }));
  }
}
