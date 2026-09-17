import { sql, n } from "../db.ts";
import { get } from "../router.ts";
import { SOLANA_NET } from "../shared/chains.ts";

/**
 * Cohort-wide conditions for the "Casino Closed" workflow (composite C4,
 * docs/consumer/composite-workflows-coverage-17-sep.md): how many tracked leaders closed green
 * this week, how many Solana launches graduated, how concentrated the cohort's rotation is.
 * One reading for everyone, so it is computed once a minute per isolate and served from memory.
 */
export type Regime = "open" | "caution" | "closed";

/** Published thresholds. `greenShare7d` sets the step; `survival7d` below its floor moves one down. */
export const RULE = { closedBelow: 0.25, cautionBelow: 0.5, survivalDowngradeBelow: 0.1 } as const;

const STEPS: readonly Regime[] = ["open", "caution", "closed"];

/** Pure. `null` when there is no green-share reading: no cohort, no regime. */
export function regimeFrom(greenShare: number | null, survival: number | null): Regime | null {
  if (greenShare === null) return null;
  const step = greenShare < RULE.closedBelow ? 2 : greenShare < RULE.cautionBelow ? 1 : 0;
  const downgrade = survival !== null && survival < RULE.survivalDowngradeBelow ? 1 : 0;
  return STEPS[Math.min(STEPS.length - 1, step + downgrade)];
}

const share = (part: number, whole: number): number | null =>
  whole > 0 ? Number((part / whole).toFixed(4)) : null;

const pct = (v: number | null): string => (v === null ? "n/a" : `${Math.round(v * 100)}%`);

const TTL_MS = 60_000;
let cache: { at: number; body: unknown } | null = null;

get("/v1/market/regime", async () => {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.body;

  /* `transactions` only holds rows fetched for tracked wallets, so no wallet join is needed. */
  const [r] = await sql`
    with leaders as (
      select handle, sum(realized_pnl_usd) as pnl
      from trades
      where closed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
      group by handle),
    launches as (
      select graduated from tokens
      where network_id = ${SOLANA_NET}
        and created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')),
    moved as (
      select token_key, count(*) as transfers
      from transactions
      where block_time >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
        and token_key is not null
      group by token_key)
    select (select count(*) from leaders)                                as leaders_total,
           (select count(case when pnl > 0 then 1 end) from leaders)     as leaders_green,
           (select count(*) from launches)                               as launches_seen,
           -- `graduated` is 0/1 now; a null is still "not graduated", as `filter (where …)` was.
           (select count(case when graduated then 1 end) from launches)  as launches_graduated,
           (select count(*) from moved)                                  as tokens_moved,
           (select coalesce(sum(transfers), 0) from moved)               as transfers_total,
           (select coalesce(sum(transfers), 0) from
              (select transfers from moved order by transfers desc limit 10) top)
                                                                         as transfers_top`;

  const leadersTotal = Number(r.leaders_total);
  const green = Number(r.leaders_green);
  const seen = Number(r.launches_seen);
  const graduated = Number(r.launches_graduated);
  const greenShare7d = share(green, leadersTotal);
  const survival7d = share(graduated, seen);
  const regime = regimeFrom(greenShare7d, survival7d);

  const body = {
    board: "market",
    asOf: new Date().toISOString(),
    window: "7d",
    regime,
    rule: {
      ...RULE,
      basis: "greenShare7d < closedBelow → closed, < cautionBelow → caution, else open; " +
             "survival7d < survivalDowngradeBelow moves the result one step down",
    },
    leaders: {
      total: leadersTotal,
      green7d: green,
      greenShare7d,
      basis: "traders with ≥ 1 trade closed in the window; green = sum(realized_pnl_usd) > 0 over those closes",
    },
    launches: {
      seen7d: seen,
      graduated7d: graduated,
      survival7d,
      chains: ["solana"],
      basis: "tokens.created_at in the window (pump.fun curve read, docs/LAUNCH_METADATA.md); graduated = curve complete",
    },
    rotation: {
      tokensMoved7d: Number(r.tokens_moved),
      topShare7d: share(n(r.transfers_top) ?? 0, n(r.transfers_total) ?? 0),
      basis: "transfers in the window across tracked wallets; topShare7d = share carried by the 10 most-moved tokens",
    },
    plain: regime === null
      ? "No tracked leader closed a trade this week, so there is no cohort reading."
      : `${pct(greenShare7d)} of tracked leaders are green this week (${green} of ${leadersTotal}); ` +
        `${seen ? `${pct(survival7d)} of ${seen} Solana launches graduated` : "no Solana launches seen"}; ` +
        `regime ${regime}. A cohort reading, not advice.`,
    cachedForSeconds: TTL_MS / 1000,
  };
  cache = { at: Date.now(), body };
  return body;
});

