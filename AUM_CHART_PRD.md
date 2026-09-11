# PRD — Trader AUM chart data

**Date:** 10 September 2026  
**Owner requirement:** “genie-fomo should cover last 30d of data.”

## 1. Outcome

The For You trader card and the trader profile must draw a truthful balance-history chart for
every registered trader. A newly registered trader must not wait 30 days before the chart works.
Genie-fomo must provide the rolling historical data; the Genie client must only select a window
and draw the returned series.

The chart has four windows:

| UI label | API window | Default step | Expected buckets |
| --- | --- | --- | --- |
| 1D | `1d` | `1h` | 24 hourly buckets |
| 7D | `1w` | `6h` | 28 six-hour buckets |
| 30D | `1m` | `1d` | 30 daily buckets |
| All | `all` | adaptive | At least the latest 30 days, plus anything older |

## 2. Current gap

`GET /traders/:handle/aum` has the right general response shape, but the live data does not yet
meet the product requirement. On 10 September 2026:

- only 8 of 435 traders had been sampled;
- `GET /traders/pointfarmcap/aum?window=1m` returned `count: 1`;
- that one point was first tracked on 10 September 2026;
- only 102 of 207 positions in that point were priced.

The route's `from` timestamp describes the requested range. It is not proof that the returned
data covers that range. Asking for `window=1m` while returning one point does not satisfy the
30-day requirement and cannot draw the chart.

## 3. Genie-fomo requirements

### 3.1 Thirty days are available, not merely requested

For every registered trader, genie-fomo must retain or rebuild a rolling 30 days of balance
history across every known wallet and every chain on which those wallets are present.

- Existing traders are bulk backfilled once.
- A newly registered trader is backfilled without waiting for future samples to accumulate.
- The ongoing sampler keeps the rolling window current.
- A failed refresh never deletes an earlier good point.
- A route request reads stored data and makes no live provider calls.

Historical points before real sampling began may be reconstructed, but they must be labelled
`basis: "rebuilt"` and `tier: "reported"`. Measurements taken from the chains at that time are
labelled `basis: "sampled"` and `tier: "verified"`. These labels must never be blurred or
discarded.

### 3.2 Every point covers the whole trader

Each point represents the trader's total across all known wallets and all supported chains, not
only Solana and not only the wallets that answered quickly.

Every point must carry:

- timestamp;
- total USD value, or `null` when no honest total is available;
- sampled or rebuilt basis;
- verified or reported tier;
- priced-position count and total-position count;
- answered-wallet count and total-wallet count;
- answered-chain count and total-chain count;
- a refusal reason when the value is `null`.

If one known wallet cannot be read, the whole point is refused. A partial wallet total must not
look like a drawdown. Missing and refused values are `null`, never zero. A genuine, completely
read empty portfolio is the only case that returns zero.

### 3.3 The service decides whether points are comparable

Counts alone do not tell Genie whether two totals were valued on a comparable basis. The API must
return a server-decided `drawable` result for the requested series:

```json
{
  "reach": {
    "requestedFrom": "2026-08-11T00:00:00Z",
    "coveredFrom": "2026-08-11T00:00:00Z",
    "coveredTo": "2026-09-10T00:00:00Z",
    "requestedDays": 30,
    "coveredDays": 30,
    "complete": true
  },
  "drawing": {
    "drawable": true,
    "usablePoints": 30,
    "reason": null
  }
}
```

When it is not drawable, `reason` is one of:

- `warming` — backfill or initial sampling is still running;
- `too_few_points` — fewer than three comparable numeric points;
- `short_coverage` — the stored reach is shorter than the requested window;
- `wallet_unreadable`;
- `service_timeout`;
- `no_prices`;
- `price_rejected`.

Genie must not infer readiness from `window`, `from`, `count`, or position counts. The service
owns this decision because it knows whether changes came from the trader or from missing data.

### 3.4 Gaps remain gaps

- Keep the last observation in each time bucket; do not average observations.
- Do not interpolate a missing or refused bucket.
- Return gaps explicitly, with their timestamps and reasons.
- A chart line must break across a gap rather than connect two points through it.
- `sum(chains[].totalUsd)` must equal `now.totalUsd` to the cent whenever the total is numeric.

## 4. Genie rendering requirements

Genie uses the same AUM route for the For You card and trader profile. It must not maintain a
second, contradictory definition of trader balance.

- Always show 1D, 7D, 30D, and All.
- Draw once the response says `drawing.drawable: true` and supplies at least three usable points.
- Plot points oldest to newest and break the line at declared gaps.
- The headline amount equals the newest point used by the chart.
- Show data coverage separately from the dollar amount.
- If the series is not drawable, show the returned reason and actual covered span. Never claim
  that the requested window is covered.
- Switching windows must reuse stored route data and must not trigger provider work.

For example, the current fallback should say “30D requested · 2 hours covered” rather than
presenting “30D” or “All” as though the whole period exists.

## 5. Readiness and progress

The route should distinguish a temporary backfill from a permanent refusal:

```json
{
  "status": "warming",
  "progress": {
    "coveredDays": 2,
    "targetDays": 30,
    "nextRunAt": "2026-09-10T22:00:00Z"
  }
}
```

The background job must report:

- traders fully covered for 30 days;
- traders still short;
- short traders grouped by reason;
- oldest and newest covered time per trader, wallet, and chain;
- last successful run and next scheduled run;
- provider calls, elapsed time, and refused work per run.

## 6. Acceptance criteria

The work is complete only when all of the following are measured against the deployed route and
the Genie testing app:

1. Every registered trader has a coverage record for every known wallet and chain.
2. `GET /traders/pointfarmcap/aum?window=1m` reports `reach.coveredDays >= 30`,
   `reach.complete: true`, and at least three comparable numeric points. The normal target is 30
   daily points.
3. The full roster count is reported: fully covered out of 435, with every short trader and its
   reason named. “The sampler has not reached them” is not completion.
4. A newly registered trader enters `warming`, is backfilled, and becomes drawable without
   waiting 30 calendar days.
5. A failed wallet or chain produces a refused point or gap, never a false zero or partial
   drawdown.
6. A failed refresh preserves all previously stored good history.
7. Rebuilt and sampled points remain visibly distinguishable in the response.
8. The 1D, 7D, 30D, and All controls each return the documented bucket size and honest reach.
9. The For You card and trader profile draw the same series and newest total for the same trader.
10. The `pointfarmcap` chart visibly renders in the Genie testing app, including axes, at least
    three points, and gaps where declared.
11. The route performs no external provider calls while serving a request.
12. The response and background-job measurements state remaining latency, coverage, and provider
    cost rather than hiding them behind a green check.

## 7. Ownership boundary

**Genie-fomo owns:** trader and wallet discovery, cross-chain historical coverage, backfill,
sampling, storage, point comparability, gaps, and coverage status.

**Genie owns:** calling the route, mapping the four controls to its windows, rendering exactly
what the response supports, and showing an honest short-coverage state when it does not.

The chart is not complete when only the frontend is wired. It is complete when genie-fomo has
the data, the API proves its actual reach, and both Genie surfaces visibly draw the same truthful
series.
