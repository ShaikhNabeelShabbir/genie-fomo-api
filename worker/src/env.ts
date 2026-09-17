/** Bindings, secrets (`wrangler secret put`) and vars (`wrangler.toml`). See docs/CLOUDFLARE_MIGRATION.md §5.1, §8 */
export interface Env {
  /** Absent until the binding in wrangler.toml is uncommented with a real id. */
  readonly HYPERDRIVE?: Hyperdrive;
  readonly GENIE_API_KEY?: string;
  readonly AUM_SAMPLE_SECRET?: string;
  readonly AUM_SAMPLE_URL?: string;
  readonly AUM_SAMPLE_BUDGET_MS?: string;
  /** Wall-clock budget for the cron jobs under `src/jobs/` (prices). */
  readonly JOB_BUDGET_MS?: string;
  readonly AUM_LIVE_AFTER_MINUTES?: string;
  readonly AUM_LIVE_WAIT_MS?: string;
  readonly WALLET_SUBMIT_SECRET?: string;
  readonly RATE_LIMIT_PER_MINUTE?: string;
  readonly ROUTE_TIMEOUT_MS?: string;
  readonly HELIUS_WEBHOOK_SECRET?: string;
  readonly HELIUS_SOLANA_KEY?: string;
}
