# Bug report — trader analytics API

Service: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api`
Probed: 2026-09-06, 18:15–18:30 PDT, build `capturedAt 2026-09-06T10:19:16Z` (131 traders, 3,272 holdings, 10,180 trades)
Reference doc: `PARAMETER_ROUTES_v2.md` (dated 2026-09-05)

Every item below has a command that reproduces it against the live service today. Severity is
from the consumer's side: what happens if the value is shown to a user as-is.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

---

## BUG-1 · `scorecard.returnPct.value` is wrong by ~15 orders of magnitude whenever it is non-null

**Severity: high.** The field exists to answer "turned $1,000 into what?". Every trader who passes
the coverage floor gets a number in the 10^17 to 10^18 range, positive or negative. Only traders
who *fail* the floor (e.g. `unipcs`, the example in the doc) return `null`, which is why the doc
does not show the fault.

| handle | moneyIn | moneyOut | returnPct.value | returnPct.coverage |
| --- | --- | --- | --- | --- |
| ether_monk | $3,008,613 | $398,631 | 877,995,983,169,867,600 | 20/40 (0.50) |
| DumbCrayonEater | $254,215 | $49,053 | 176,692,659,911,358,200 | 20/25 (0.80) |
| salem1299534 | $863,837 | $332,311 | −257,037,338,970,832,160 | 9/26 (0.35) |
| Natan_benish | $9,326 | $4 | −1,927,368,240,094,668,300 | 18/19 (0.95) |
| PoorGoat_ | $831,704 | $1,699,903 | −85,950,355,053,666,260 | 9/25 (0.36) |
| unipcs | $2,965,815 | $2,502,695 | null | 3/43 (0.07) |

Five of six traders probed. The inputs on the same response are sane (dollar figures in the
thousands to millions, entry prices 0.0009–0.04, typical bet $4,460), so the ratio itself has a
unit or denominator error — the magnitude suggests a per-token price or a raw supply is being
used where a dollar amount should be, or a percent is being compounded per trade instead of summed.

```bash
for h in ether_monk DumbCrayonEater salem1299534 Natan_benish PoorGoat_; do
  curl -s "$B/traders/$h/scorecard" | jq -c --arg h $h '{h:$h, returnPct, moneyIn: .moneyIn.usd, moneyOut: .moneyOut.usd}'
done
```

**Expected:** a percentage in a plausible range (ether_monk with $3.0M in and $0.4M out should be a
large negative number of percent, not 8.8 × 10^17), or `null` with the coverage object.

---

## BUG-2 · `/trust` marks ranks 1, 2 and 3 on the board "implausible"

**Severity: high.** The verdict, verbatim, says "Reported profit is larger than everything they
have ever traded. That cannot come from trading alone." for the top three traders on the board.

| rank | handle | verdict | pnlToVolume | flags |
| --- | --- | --- | --- | --- |
| 1 | unipcs | implausible | 5.96 | pnl_exceeds_volume, partial_pricing |
| 2 | ogle | implausible | 17.64 | pnl_exceeds_volume, pnl_exceeds_holdings, partial_pricing |
| 3 | DumbCrayonEater | implausible | 5.98 | pnl_exceeds_volume, pnl_exceeds_holdings, partial_pricing |
| — | 0xAvast | implausible | 3.06 | same three |
| — | ether_monk | ok | 0.32 | partial_pricing |
| — | frankdegods | ok | 0.04 | partial_pricing |

The cause is visible in the same responses. `pnl_exceeds_volume` compares fomo's REPORTED
lifetime profit against the volume this service has STORED, which is partial: for ogle, stored
volume is $357,013 against reported profit $6.3M, but ogle's scorecard shows `moneyIn` coverage
of a fraction of trades. `pnl_exceeds_holdings` compares reported profit to a portfolio value
computed from **7 of 56 priced positions** (`portfolio.coverage.pricedShare: 0.125`), so "2364×
the value of everything they hold" is 2364× one-eighth of the portfolio.

```bash
curl -s "$B/traders/ogle/trust" | jq '{verdict, pnlToVolume, flags: [.flags[].code], plain}'
curl -s "$B/traders/ogle/portfolio" | jq '{positions, coverage}'
```

**Expected:** either (a) the two "exceeds" flags are suppressed when the denominator's own coverage
is below a floor (the same rule `returnPct` already applies), or (b) the verdict is limited to
"unverifiable" with the coverage stated, never "implausible" / "cannot come from trading alone".
As shipped, the sentence reads as an accusation and would be shown against the whole top of the board.

---

## BUG-3 · `?limit=` with a non-numeric value returns 200 and the full list, not 400

**Severity: low.** The doc (§0a) says a bad parameter returns `400 bad_request` naming the
parameter. `?limit=abc` returns 200 with all 131 entries.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$B/traders?limit=abc"   # 200, expected 400
curl -s "$B/traders?limit=abc" | jq '.count'                       # 131
```

---

## ISSUE-4 · "Average entry" is the first entry, not an average (labelling)

**Severity: medium (semantic).** `byToken[].avgEntryPrice` and `avgEntryMarketCapUsd` are
documented as "what did they pay to get in — as a market cap" (T17) and drive `crowdAvgEntryPrice`
on the token activity route (K5). The route's own `entryBasis.note` says:

> "fomoapi supplies one avgEntryPrice per trade; we surface the **first non-zero value per token
> and do not re-average across trades**. A sell does not change it."

So the figure is the entry price of the trader's first recorded trade in that token, not the
average over their buys. The field name and the doc row both say "average". Either rename
(`firstEntryPrice`) or actually average, and say which in the doc.

```bash
curl -s "$B/traders/ether_monk/scorecard" | jq '{entryBasis, first: .byToken[0]}'
```

---

## ISSUE-5 · Per-chain "realized" profit is published for chains with 0% pricing

**Severity: medium (misleading).** `/chains` reports realized profit per chain (robinhood
+$1,754,586, bsc +$2,594,163, base +$680,135) while the same response says those chains have
`coverage.pricedShare: 0` and `totalValueUsd: null`. The doc (§7b) notes the realized figure comes
from fomo's own trade records and "is not independently verified", but the response carries no such
marker, so a consumer reading `realized.pnlUsd` beside `pricedShare: 0` cannot tell how a chain with
no prices has a dollar profit.

| chain | traders | positions | pricedShare | totalValueUsd | closed | realized.pnlUsd |
| --- | --- | --- | --- | --- | --- | --- |
| robinhood | 66 | 1262 | 0 | null | 2546 | 1,754,585.98 |
| solana | 83 | 1222 | 0.696 | 27,610,109 | 714 | −1,652,913.87 |
| bsc | 60 | 531 | 0 | null | 793 | 2,594,163.41 |
| base | 38 | 154 | 0 | null | 98 | 680,135.20 |
| ethereum | 58 | 103 | 0 | null | 69 | −213,567.96 |

Suggest a `source: "reported"` (or `tier`) field on `realized`, matching the reported/stored split
used on `/traders/:handle`.

```bash
curl -s "$B/chains" | jq -r '.entries[] | [.chain, .coverage.pricedShare, .totalValueUsd, .realized.pnlUsd] | @tsv'
```

---

## ISSUE-6 · Momentum cannot separate "leaders bought" from "token newly loaded"

**Severity: medium.** The top `/tokens/momentum` entry today is a Robinhood token with
`holders: 24, previousHolders: 0, isNew: true` and the sentence "New — 24 leaders opened a position
since the last snapshot." With `previousHolders: 0` this is equally consistent with the token
appearing in the loader for the first time. `isNew` lets a consumer filter, but the `plain`
sentence asserts a buy that the data does not establish. Suggest the sentence for `isNew` rows
say "first seen in this snapshot; 24 leaders hold it" and reserve "opened a position" for rows
with `previousHolders > 0`.

```bash
curl -s "$B/tokens/momentum" | jq '.entries[0] | {chain, holders, previousHolders, change, isNew, plain}'
```

---

## ISSUE-7 · No rate-limit headers on successful responses

**Severity: low.** The doc documents `429` with `Retry-After`, but a 200 carries no
`RateLimit-Limit` / `RateLimit-Remaining` headers, so a client cannot pace itself before the
first 429. Eight concurrent requests all returned 200 in ~2 s, so the limit was not reached in
this probe; it is simply not discoverable. Also: the doc's error table lists `401 unauthorized —
the key is missing or wrong`, but the service is keyless; that row should go or say when a key
is required.

```bash
curl -s -D - -o /dev/null "$B/health" | grep -i ratelimit   # nothing
```

---

## ISSUE-8 · Latency: ~2 s per call, 7 s for `/health`

**Severity: low, operational.** Single calls measured 1.85–2.18 s; `/health` 7.3 s. For a
consumer syncing 131 traders × 7 sub-routes (~900 calls) that is ~30 minutes sequentially. A
bulk endpoint (e.g. `GET /traders?include=pnl,scorecard`) or a lower per-call latency would let
an hourly sync fit comfortably.

```bash
for i in $(seq 8); do curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "$B/traders/unipcs/pnl" & done; wait
```

---

## ISSUE-9 · Error body duplicates `detail` at the top level

**Severity: cosmetic.** A 404 for an unknown handle returns `{"error":{"code","detail"},"detail"}`
— the same string twice at two depths. The doc says the body is `{ "error": {...} }`.

```bash
curl -s "$B/traders/definitely_not_a_handle/pnl"
```

---

## DOC-10 · Every number in `PARAMETER_ROUTES_v2.md` is stale against the service

Not a bug in the API; a note for whoever maintains the doc. It says 100 traders, 2,038 holdings,
6,398 trades, 42,033 transfers; the service today has 131 / 3,272 / 10,180 / 234,705. Robinhood
closed trades went from 1,396 to 2,546 since the doc's §7b table. The doc reads as if pulled
from the live service ("every value shown below was pulled from the live service"), so a
`generatedAt` line at the top would stop readers trusting numbers a day old.

---

## What is solid (for the record)

Win rate with wins/losses, closed-trade counts, `topTradeShare`, `holdingTime`, `lastTradeAt`,
`trackRecordDays`, `tradesPerDay` — all populated and plausible on every trader probed; timestamps
100% populated as the doc says. Token activity (`everSold`, `holdersWhoSold`, `flow`, per-holder
entry/exit) returns consistent shapes. The null-never-zero and coverage-object conventions hold
everywhere they were checked. The 404 route list is a genuinely useful touch.
