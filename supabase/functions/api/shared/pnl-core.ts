import { sql, n, round } from "../db.ts";
import { money } from "../shared/format.ts";
import { scorecardBody } from "../shared/scorecard-core.ts";

// ------------------------------------------------------ T1 banked vs on paper

/**
 * The P&L aggregate, grouped so the bulk route gets every trader in one statement.
 *
 * Note `group by` returns NO row for a trader with no trades, where the single-trader query
 * returned one row of zeros. `pnlBody` therefore treats a missing row and a zero row
 * identically — see its signature.
 */
export const pnlAgg = (handles: string[]) => sql`
  select handle,
         count(*) filter (where status = 'closed')::int  as closed,
         count(*) filter (where status <> 'closed')::int as open,
         coalesce(sum(realized_pnl_usd)   filter (where status = 'closed'), 0)  as realized,
         coalesce(sum(unrealized_pnl_usd) filter (where status <> 'closed'), 0) as unrealized,
         max(captured_at) as captured
  from trades where handle = any(${handles}) group by handle`;

/**
 * Split out for ISSUE-8, same reasoning as `scorecardBody`: the bulk route runs this exact
 * function rather than a parallel implementation that would drift on the first edit.
 */
// deno-lint-ignore no-explicit-any
export function pnlBody(t: any, r: any | undefined) {
  const closed = Number(r?.closed ?? 0), open = Number(r?.open ?? 0);
  const realized = (r ? n(r.realized) : 0) ?? 0, unrealized = (r ? n(r.unrealized) : 0) ?? 0;
  const any = closed + open > 0;

  /**
   * Sign discipline. A naive `total !== 0` guard lets realized -$8,000 and unrealized
   * -$2,000 render as "80% banked" for a trader who LOST $10,000. A share is emitted only
   * when both sides are positive; every other case gets the dollar figures and no ratio.
   */
  const share = any && realized > 0 && unrealized > 0
    ? Number((realized / (realized + unrealized)).toFixed(4)) : null;

  let plain: string;
  if (!any) plain = "No trades on record for this trader.";
  else if (share !== null) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades. ` +
            `${money(unrealized)} is still on paper in ${open} open position${open === 1 ? "" : "s"} ` +
            `— ${Math.round(share * 100)}% of the total is actually banked.`;
  } else if (realized > 0) {
    plain = `Cashed out ${money(realized)} across ${closed} closed trades, and is currently down ` +
            `${money(Math.abs(unrealized))} on open positions.`;
  } else if (unrealized > 0) {
    plain = `${money(unrealized)} of gains are on paper only — nothing has been banked yet ` +
            `across ${closed} closed trades.`;
  } else {
    plain = `Down ${money(Math.abs(realized))} on closed trades and ` +
            `${money(Math.abs(unrealized))} on open ones.`;
  }

  return {
    handle: t.display_handle, name: t.name ?? null,
    source: "postgres · trades",
    bankedUsd: any ? round(realized) : null,
    closedTrades: closed,
    onPaperUsd: any ? round(unrealized) : null,
    openPositions: open,
    realizedShare: share,
    /** WHY `realizedShare` IS NULL, as a machine word rather than only in `plain`. See docs/DECISIONS.md#d135 */
    realizedShareReason: share !== null
      ? null
      : (!any
        ? "no_trades_on_record"
        : (realized <= 0 && unrealized <= 0
          ? "nothing_banked_or_on_paper"
          : "sign_discipline_not_both_positive")),
    // Same value under both names. `asOf` is the convention every other money route uses;
    // `capturedAt` predates it and is kept so existing consumers do not break.
    asOf: r?.captured ? new Date(String(r.captured)).toISOString() : null,
    capturedAt: r?.captured ?? null,
    plain,
  };
}
