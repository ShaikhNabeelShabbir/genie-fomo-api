import type { Env } from "../env";
import { jobSql } from "../sql";
import { runWith } from "../../../supabase/functions/api/db.ts";
import { refreshHealthSnapshot } from "../../../supabase/functions/api/routes/health.ts";

export interface HealthSnapshotSummary { readonly computedAt: string; readonly tookMs: number }

/** /health reads one row; this writes it, so the heavy reads run on a clock and not per request. */
export async function runHealthSnapshot(env: Env, _budgetMs: number): Promise<HealthSnapshotSummary> {
  // The store carries string vars only, as in api.ts; the binding stays on `env` for `jobSql()`.
  const { DB: _db, ...vars } = env;
  const snap = await runWith({ sql: jobSql(env), env: vars }, () => refreshHealthSnapshot());
  return { computedAt: snap.computed_at, tookMs: snap.took_ms };
}
