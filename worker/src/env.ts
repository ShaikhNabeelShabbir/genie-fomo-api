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
  /** Traders per chain-balance run (`jobs/balances.ts`); default 25. */
  readonly BALANCE_SLICE?: string;
  /** Transfer backfill providers (`jobs/transfers.ts`): Etherscan V2 for Ethereum, Bitquery for BSC/Base. */
  readonly ETHERSCAN_KEY?: string;
  readonly BITQUERY_KEY?: string;
  /** Where Helius delivers; the watch-list sync registers this URL. Defaults to the Supabase receiver. */
  readonly WEBHOOK_URL?: string;
  /** Wall-clock budget for a cron job (`jobs/*`), ms. */
  /** fomoapi bearer for the scorecard refresh (`jobs/scorecards.ts`). */
  readonly FOMOAPI_KEY?: string;
  /** GMGN key for the token fundamentals refresh (`jobs/tokens.ts`). */
  readonly GMGN_API_KEY?: string;
}
