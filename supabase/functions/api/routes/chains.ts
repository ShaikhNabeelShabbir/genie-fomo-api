import { sql, n, round } from "../db.ts";
import { get } from "../router.ts";
import { asOfHoldings } from "../shared/asof.ts";
import { money } from "../shared/format.ts";

// ------------------------------------------------------------- C1/C2/C4/C5

get("/v1/chains", async () => {
  const rows = await sql`
    select c.network_id, c.name, c.history_provider,
           count(h.*)                                   as positions,
           count(distinct h.handle)                     as traders,
           count(distinct h.token_key) filter (
             where q.token_key is null)                 as tokens,
           count(h.value) filter (where h.value > 0)    as priced,
           sum(h.value)   filter (where h.value > 0)    as total_value
    from chains c
    join holdings_current h on h.network_id = c.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    group by c.network_id, c.name, c.history_provider
    order by positions desc`;

  const [{ traders: traderCount }] = await sql`select count(*)::int as traders from traders`;
  const [{ total }] = await sql`select count(*)::int as total from holdings_current`;

  /** C3 — realized profit per chain. See docs/DECISIONS.md#d060 */
  const profit = await sql`
    select t.network_id,
           count(*) filter (where t.status = 'closed')::int as closed,
           coalesce(sum(t.realized_pnl_usd) filter (where t.status = 'closed'), 0) as realized
    from trades t group by t.network_id`;
  const byNet = new Map(profit.filter((r) => r.network_id !== null)
    .map((r) => [Number(r.network_id), r]));
  const orphan = profit.find((r) => r.network_id === null);

  const top = rows[0];
  return {
    board: "chains",
    asOf: await asOfHoldings(),
    /** THE CHAIN VOCABULARY IS CLOSED, AND SAYS SO. See docs/DECISIONS.md#d061 */
    vocabulary: {
      closed: true,
      version: 1,
      words: rows.map((r) => String(r.name)).sort(),
      note: "one word per network id, one network id per word. Ask with these verbatim; " +
            "a word not in this list is not a chain this service indexes",
    },
    traders: Number(traderCount),
    totalPositions: Number(total),
    count: rows.length,
    // Never folded into a chain row: attributing it would misstate whichever row absorbed it.
    unattributedRealized: orphan
      ? { closedTrades: Number(orphan.closed), pnlUsd: round(n(orphan.realized)),
          note: "closed trades whose chain could not be established" }
      : null,
    plain: top
      ? `${top.traders} of ${traderCount} leaders trade ${top.name}, which carries ` +
        `${top.positions} of ${total} positions on the board.`
      : "No positions in the directory.",
    entries: rows.map((r) => {
      const positions = Number(r.positions);
      const priced = Number(r.priced);
      const pricedShare = positions ? Number((priced / positions).toFixed(4)) : null;
      const name = r.name as string;
      return {
        networkId: Number(r.network_id),
        chain: name,
        traders: Number(r.traders),
        traderShare: Number((Number(r.traders) / Number(traderCount)).toFixed(4)),
        positions,
        tokens: Number(r.tokens),
        totalValueUsd: priced ? round(n(r.total_value)) : null,
        coverage: { pricedPositions: priced, unpricedPositions: positions - priced, pricedShare },
        // Lead with the caveat when the money figure rests on a minority of the rows.
        plain: pricedShare !== null && pricedShare < 0.5
          ? `${r.traders} of ${traderCount} leaders trade ${name}, but only ${priced} of ` +
            `${positions} positions there have a usable price — the value figure is partial.`
          : `${r.traders} of ${traderCount} leaders trade ${name}, across ${positions} positions.`,
        // C3
        realized: (() => {
          const p = byNet.get(Number(r.network_id));
          return {
            closedTrades: p ? Number(p.closed) : 0,
            pnlUsd: p ? round(n(p.realized)) : null,
            basis: "sum of realized_pnl_usd over closed trades recorded on this chain",
            /**
             * A chain can show `pricedShare: 0` and a dollar profit at the same time, and
             * that looks like a contradiction unless the response says where each number
             * comes from. Profit is fomo's REPORTED trade records; pricing is the holdings
             * snapshot. Different sources, different completeness — so the tier is stated
             * rather than left to be inferred.
             */
            tier: "reported",
            source: "fomoapi trade records",
            note: "independent of this chain's price coverage — see coverage.pricedShare, " +
                  "which describes the holdings snapshot, not these trades",
          };
        })(),
        historyCoverage: {
          available: !!r.history_provider,
          via: r.history_provider ?? null,
          // Blockscout needs no key at all, which is worth saying out loud: it is the only
          // free history we have on Robinhood.
          note: r.history_provider === "blockscout" ? "keyless" : null,
        },
        // Free and keyless on all five chains, so a position SIZE is always checkable even
        // where the transaction history behind it is not.
        balanceVerifiable: true,
      };
    }),
  };
});
