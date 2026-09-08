# Debugging plan — from the 2026-09-06 bug report

Every item below was **reproduced against the live service** before being written down. Where
the report's diagnosis differs from what I found, the difference is stated — two of them do.

Ordered by what a consumer would show a user, not by effort.

**Figures differ slightly from the report because the two probes ran hours apart and the
pipeline refreshes nightly.** `ogle`'s `pnlToVolume` was 17.64 in the report and 13.37 when I
re-ran it; its portfolio coverage was 7 of 56 and is now 6 of 48. Neither of us mismeasured —
every finding still reproduces, only the magnitudes move.

```bash
export B=https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api
```

Item numbering follows `FOMO_API_BUG_REPORT.md` exactly — **BUG-1 here is BUG-1 there**, and so
on through DOC-10. Nothing has been merged, split or renumbered.

| Report ID | Item | Severity | Fix effort | Status |
| --- | --- | --- | --- | --- |
| **BUG-1** | `returnPct` off by ~10^17 | **high** | 1h | ✅ done |
| **BUG-2** | `/trust` calls the top of the board "implausible" | **high** | 2h | ✅ done |
| **BUG-3** | `?limit=abc` returns 200 | low | 30m | ✅ done |
| **ISSUE-4** | "average entry" is the first entry | medium | 1h | ✅ done |
| **ISSUE-5** | Per-chain realized profit unlabelled | medium | 30m | ✅ done |
| **ISSUE-6** | Momentum asserts a buy it cannot see | medium | 30m | ✅ done |
| **ISSUE-7** | No rate-limit headers; `401` documented but impossible | low | 1h | ✅ done |
| **ISSUE-8** | ~2s per call, no bulk route | low | 1d | ⬜ |
| **ISSUE-9** | `detail` duplicated in error bodies | cosmetic | 15m | ✅ done |
| **DOC-10** | Doc numbers stale, no `generatedAt` | doc | 30m | ✅ done |

**Total: about 2.5 days**, of which ISSUE-8 is a day on its own.
**9 of 10 done** (BUG-1, BUG-2, BUG-3, ISSUE-4, ISSUE-5, ISSUE-6, ISSUE-7, ISSUE-9, DOC-10) — all verified live, all 15 routes still 200.
Remaining: **ISSUE-8** (bulk `?include=` route, ~1d).

---

## BUG-1 · `returnPct` is off by ~10^17 — **the report's diagnosis is wrong, and the truth is worse**

Reproduced. `ether_monk` returns `877,995,983,169,868,200`.

The report guesses "a per-token price or a raw supply used where a dollar amount should be".
It is not a unit error. The measured cause:

```
open trades    avg amount  25,806,417       real position size
closed trades  avg amount        -240       2,378 of 3,220 are exactly 0

2,866 closed trades have a cost basis under $1 but a realized P&L over $100
```

`amount` on a **closed** trade is what remains in the position — nothing, because it was sold.
The route computes cost basis as `amount × avgEntryPrice` over closed trades, so it divides a
real dollar P&L by dust:

```
STONK    amount 0.0000000149  ×  entry 0.00818  =  basis $0.00000000012
         realized_pnl_usd 379,175
         ratio ≈ 3 × 10^15
```

**So a cost basis for a closed trade cannot be computed from this data at all.** fomo does not
report what was originally bought, only what is left. No arithmetic fix exists.

**Fix:** return `null` for every trader and say why, exactly as the coverage rule already does
when evidence is thin. `returnPct` becomes available only when the chain replay lands, because
that reconstructs the basis from actual buys.

```bash
curl -s "$B/traders/ether_monk/scorecard" | jq '.returnPct'
```

### ✅ Done — 2026-09-06 · and the conclusion above was wrong

I wrote that no arithmetic fix exists and T3 should go back to unavailable. That was too
pessimistic. The basis cannot be READ, but it can be DERIVED, because the quantity cancels:

```
pnl   = qty x (exit - entry)      ->   qty   = pnl / (exit - entry)
basis = qty x entry               ->   basis = pnl x entry / (exit - entry)
```

No position size is needed. Summing basis and pnl across a trader's closed trades gives a
**money-weighted** return — a $1M trade counts more than a $10 one, which an average of
per-trade percentages would not.

Trades where the derivation cannot hold are dropped, not approximated: exit equal to entry
(zero divisor), and the 29 of 3,176 whose implied basis is negative — pnl and the price move
disagreeing in sign means the trade is not a simple long and the formula does not describe it.

Verified against the report's own six traders:

```
ether_monk        877,995,983,169,868,200  ->     74.67%   coverage 17/40
DumbCrayonEater   176,692,659,911,358,300  ->     16.79%   coverage 20/26
salem1299534     -257,037,338,970,832,160  ->    -39.12%   coverage  9/27
Natan_benish   -1,927,368,240,094,668,300  ->    -27.93%   coverage 18/19
PoorGoat_         -85,950,355,053,666,260  ->    -27.19%   coverage 12/41
unipcs                               null  ->    -70.72%   coverage  3/43
```

And across the top 40 traders: **0 absurd values**, range −88.7% to +302.1%, median −2.7%.

**T3 stays live.** One thing to watch: `unipcs` now returns a number from 3 of 43 closed
trades. That is 7% coverage — thin, but real, and the coverage object says so, which is the
convention every other figure here follows.

### Verified against the report's own command — 2026-09-06

```
{"h":"ether_monk",      "returnPct":74.67,  "cov":0.425,  "moneyIn":3189503.83, "moneyOut":398631.93}
{"h":"DumbCrayonEater", "returnPct":16.79,  "cov":0.7692, "moneyIn":259205.81,  "moneyOut":49053.64}
{"h":"salem1299534",    "returnPct":-39.12, "cov":0.3333, "moneyIn":881324.9,   "moneyOut":332430.05}
{"h":"Natan_benish",    "returnPct":-27.93, "cov":0.9474, "moneyIn":9326.79,    "moneyOut":4.13}
{"h":"PoorGoat_",       "returnPct":-27.19, "cov":0.2927, "moneyIn":806643.12,  "moneyOut":1676769.35}
```

**The report's expected SIGN for `ether_monk` was wrong, and that is worth recording.** It
said "$3.0M in and $0.4M out should be a large negative number of percent". `ether_monk`'s
closed trades are **+$916,699**. The reasoning failed because `moneyIn` and `moneyOut` are not
two halves of one ledger: money-in includes positions **still open**, which cannot have an exit
price. 22 of that trader's 42 entry-priced trades are open.

That misreading is the fault of the response, not the reader — so a second fix came out of
verifying the first.

### Second fix — the caveat that should have prevented it

The "different subsets" caveat compared **counts**, and `ether_monk` has 42 entry prices and 42
exit prices. Equal counts, different trades, so it never fired. It now compares set membership:

```
"Money-in covers 42 trades and money-out covers 42, but only 20 are the same trade —
 money-in includes positions still open, which have no exit yet. Subtracting one from the
 other is NOT a profit figure; use returnPct or /pnl."
```

Equal cardinality is not overlap.


---

## BUG-2 · `/trust` calls ranks 1, 2 and 3 "implausible"

Reproduced, and the report's diagnosis is **correct**:

```
unipcs           implausible  pnlToVolume 5.08   pnl_exceeds_volume, partial_pricing
ogle             implausible  pnlToVolume 13.37  + pnl_exceeds_holdings
DumbCrayonEater  implausible  pnlToVolume 6.65   + pnl_exceeds_holdings

ogle portfolio:  48 positions, 6 priced  (pricedShare 0.125)
```

`pnl_exceeds_holdings` divides fomo's reported lifetime profit by a portfolio value built from
**6 of 48 positions**. "2,364× everything they hold" is 2,364× one-eighth of what they hold.
`pnl_exceeds_volume` has the same shape.

The sentence shipped is *"That cannot come from trading alone."* — an accusation, derived from a
denominator we know is incomplete. **This is the same coverage discipline the rest of the API
applies, missing from the one route whose entire job is judging other people's numbers.** That
is the sharpest version of the finding and it is worth stating plainly.

**Fix:** suppress both "exceeds" flags when the denominator's own `pricedShare` is below 0.5,
and when suppressed emit `verdict: "unverifiable"` with the coverage attached — never
"implausible". Keep `too_few_trades`, which has no coverage problem.

### ✅ Done — 2026-09-06 · but only ONE flag had the problem

The report says `pnl_exceeds_volume` "compares fomo's REPORTED lifetime profit against the
volume this service has STORED, which is partial". It does not. `volume_usd` is fomo's own
figure, stored verbatim by `load_to_db.py`:

```
unipcs   fomo pnl $17,852,542  ÷  fomo volume $3,513,006  = 5.08
ogle     fomo pnl  $5,320,901  ÷  fomo volume   $398,122  = 13.37
```

Both sides are theirs. A trader reported as making 13x their entire lifetime volume is a
contradiction inside fomo's data and has nothing to do with our coverage — **so that flag
stays.** Suppressing it would have hidden a real finding.

`pnl_exceeds_holdings` is the one that was wrong: its denominator is our sum of priced
positions, 6 of 48 for `ogle`. That is now gated at the same 0.5 floor the rest of the API
uses, and below it emits `holdings_coverage_too_low` (severity `info`) explaining why no
conclusion is drawn.

**The verdict was also renamed.** `implausible` judged the trader; `self_contradictory`
describes the numbers, which is all the data supports. And the sentence changed from a
conclusion to the arithmetic:

```
was:  "Reported profit is larger than everything they have ever traded.
       That cannot come from trading alone."
now:  "fomo reports $5,320,901 of profit on $398,122 of lifetime volume — a ratio of 13.37x.
       Both figures are fomo's own, so they disagree with each other regardless of what we hold."
```

A `basis` block now names each denominator so the verdict can be weighed rather than taken:

```json
"pnlToVolume":   { "denominator": "fomo reported volume", "bothReported": true }
"pnlToHoldings": { "denominator": "our sum of priced positions",
                   "pricedPositions": 6, "totalPositions": 48, "pricedShare": 0.125 }
```

Verified across the top of the board:

```
unipcs           self_contradictory  5.08   pnl_exceeds_volume, partial_pricing
DumbCrayonEater  self_contradictory  6.65   pnl_exceeds_volume, pnl_exceeds_holdings
ogle             self_contradictory 13.37   pnl_exceeds_volume, holdings_coverage_too_low
0xAvast          self_contradictory  2.11   pnl_exceeds_volume, holdings_coverage_too_low
ether_monk       ok                  0.30   partial_pricing
frankdegods      ok                  0.03   partial_pricing
```

`DumbCrayonEater` keeps `pnl_exceeds_holdings` because 50 of 80 positions are priced — above
the floor, so the claim is supportable there.

---

## BUG-3 · `?limit=abc` returns 200 with the full list

Reproduced: `?limit=abc` → 200/131 rows, `?limit=-5` → 200.

The code treats any unparseable limit as "no limit". §0a of the doc promises
`400 bad_request` naming the parameter.

**Fix:** reject a present-but-invalid `limit` with 400. Absent stays "everything" — that is
deliberate and documented. Same for `offset`, `minHolders`, `holders`, `tokens`, `pages`.

### ✅ Done — 2026-09-06

Replaced 8 hand-rolled parses with one `intParam()` helper. Patching each site individually
would have been quicker and would have left the next one to be written wrong again; the raw
pattern no longer appears anywhere.

The error names the parameter, which the previous silence could not:

```json
{ "code": "bad_request", "detail": "'limit' must be a whole number — got 'abc'",
  "parameter": "limit" }
```

Every numeric parameter on every route now rejects bad input:

```
400  /traders?limit=abc                       parameter=limit
400  /traders?offset=abc                      parameter=offset      <- was silently ignored
400  /traders?limit=-5                        parameter=limit
400  /traders?limit=1.5                       parameter=limit
400  /tokens?minHolders=abc                   parameter=minHolders
400  /traders/unipcs/scorecard?tokens=abc     parameter=tokens
400  /traders/unipcs/transactions?limit=abc   parameter=limit
400  /tokens/momentum?limit=abc               parameter=limit
```

And valid input is unchanged — `?limit=3` gives 3, absent gives everything (137), the
transactions cap still clamps 9999 to 500 rather than erroring:

```
200  /traders?limit=3                    count=3
200  /traders                            count=137
200  /traders/unipcs/scorecard?tokens=0  count=0
     /traders/unipcs/transactions?limit=9999 -> limit 500, count 500
```

Two decisions worth recording. **`?offset=abc` was silently ignored before** — not mentioned in
the report, found by auditing the other seven sites. And **`?tokens=0` is allowed** (min 0)
because "return no per-token rows" is a sensible request, where every other limit takes min 1.

---

## ISSUE-4 · "Average entry" is the first entry

Confirmed by the route's own `entryBasis.note`: *"we surface the first non-zero value per token
and do not re-average across trades"*. The field is named `avgEntryPrice` and documented as an
average; it is neither.

**Fix:** actually average, weighted by `amount`, across that token's buys — and where the weight
is missing, fall back to the first value and say so in `entryBasis`. Renaming to
`firstEntryPrice` is the cheaper option but changes a published field name, so averaging is
preferable.

Note this propagates: `crowdAvgEntryPrice` (K5) is a mean of these per-trader values, so it is
an average of first-entries, not an average of entries.

### ✅ Done — 2026-09-08

**The report's cheaper option would have made it worse.** It offered "rename to
`firstEntryPrice`" as the low-cost fix. The data says no: a fomo "trade" is a POSITION, not
a fill — one `ether_monk` row opens 2026-04-24 and closes 2026-08-31 carrying a single
`avgEntryPrice` — so fomo has already averaged across the fills inside it.

| | positions | share |
| --- | --- | --- |
| One position in that token — the value already IS an average | 9,886 | **96.9%** |
| Several positions — we took the first; the name was wrong | 319 | 3.1% |

Renaming would have mislabelled 96.9% of rows to fix 3.1%. So: **actually average**, per the
report's second option. Where the defect bit, it bit hard — median 38.5% off the weighted
figure, 71% off by more than 10%.

**The weight problem, and why it was solvable.** Averaging needs a quantity, and `amount` is
not one: on a CLOSED position it is what REMAINS (nothing — it was sold), the same defect
that made BUG-1 wrong by ~10^17. Weighting by it would have repeated BUG-1 in a new place.
So the weight is status-dependent, in `trade_qty()`
(`20260908120000_trade_qty.sql`):

* **open** legs weight by `amount` — there it genuinely is the position
* **closed** legs recover quantity from BUG-1's own identity, `qty = pnl / (exit − entry)`

Coverage: 116 open legs from `amount`, 574 closed from the identity, **690 of 704 (98.0%)**.
At position level **305 of 319 fully weighted, 14 partial, none with no weight at all**.

**A second bug found while fixing this.** K5 did not compute the "first entry" its own
documentation claimed — it computed `min(avg_entry_price)`, the *cheapest* entry the trader
ever got. So the scorecard (first) and K5 (minimum) disagreed with each other as well as with
the doc. Both now use the same weighted rule.

**Your two calls, both resolved from the report itself:**

1. *Do sold-out legs count?* **Yes — all positions ever.** The report's complaint is only
   that we "do not re-average across trades"; it quotes "A sell does not change it" as
   description, not as a defect. `sellsReduceIt: false` stands, so the only reason a number
   moves is the bug fix.
2. *How to combine holders in K5?* **One trader, one vote — unchanged.** The report flags K5
   purely as propagation: "an average of first-entries, not an average of entries". The
   inputs were the defect; the combination was not. Weighting by size would answer a
   different question and be set almost entirely by the largest holder.

**Verified live — all 319 affected positions recomputed in SQL and compared to the API:**

```
positions compared : 319
match              : 319
mismatch           : 0

entryMethod across every token of the 100 affected traders:
  single_position   3699     one position; fomo already averaged inside it
  weighted           305     averaged across positions, every leg weighted
  weighted_partial    14     some legs had no recoverable quantity
  first_only           0     never needed
  (null)            3216     no entry price on record at all
```

Worked example — `sadcrissy` / CTO, 7 positions:

```
avgEntryPrice     0.00296464623767   was 0.000302014   (9.8x)
firstEntryPrice   0.000302014        the old value, kept for reconciliation
entryMethod       weighted           7 of 7 positions weighted
K5 per-holder     0.0029646462376667 was min() = 0.000302014
```

Single-position tokens are **bit-identical** to before (`ether_monk` 牛来 `0.0411376`,
market cap `41137600`), so 96.9% of rows did not move.

**New fields:** `entryMethod`, `entryPositions`, `entryPositionsWeighted`, `exitMethod`,
`firstEntryPrice` on `byToken[]`; `entryPositions`/`entryPositionsWeighted` on K5's
`perHolder[]`; `method`, `holdersMultiPosition`, `holdersFullyWeighted` on
`crowdAvgEntryPrice`. `entryBasis` now documents the weighting rule and the sell semantics.

**Also fixed in passing:** `firstEntryPrice` initially returned the wrong leg. The sort key
stringified a `Date`, and `"Wed Apr 10 2026…"` vs `"Fri Aug 01 2026…"` compares by weekday
name. Now a zero-padded epoch. Caught by the 7-position worked example above.

---

## ISSUE-5 · Per-chain realized profit carries no tier marker

Reproduced:

```
robinhood  pricedShare 0    totalValue null    realized  +$1,679,429
bsc        pricedShare 0    totalValue null    realized  +$6,211,462
solana     pricedShare 0.78 totalValue $36.0M  realized  −$1,103,437
```

A chain with no prices reporting a dollar profit is not a contradiction — the profit comes from
fomo's trade records and the pricing from holdings — but nothing in the response says so.

**Fix:** add `realized.tier: "reported"` and `realized.source: "fomoapi trade records"`, matching
the reported/stored split already on `/traders/:handle`.

### ✅ Done — 2026-09-06

`realized` now carries `tier`, `source` and a `note` saying the profit is independent of that
chain's price coverage, because `coverage.pricedShare` describes the holdings snapshot and not
these trades. Verified live:

```
solana     pricedShare 0.7827   pnl −1,103,437   tier reported
robinhood  pricedShare 0        pnl +1,679,429   tier reported
bsc        pricedShare 0        pnl +6,211,462   tier reported
```

---

## ISSUE-6 · Momentum asserts a buy it cannot see

Reproduced: `holders: 43, previousHolders: 0, isNew: true` with
*"New — 43 leaders opened a position since the last snapshot."*

With no previous snapshot for that token, "43 leaders bought it" and "the loader saw this token
for the first time" are indistinguishable. The flag is honest; the sentence is not.

**Fix:** for `isNew` rows say *"first seen in this snapshot; 43 leaders hold it"*. Reserve
"opened a position" for `previousHolders > 0`.

### ✅ Done — 2026-09-06

The sentence now states what is observed and names the ambiguity outright rather than leaving
it to the `isNew` flag:

```
prev=0 now=43 isNew=true
"First seen in this snapshot — 43 leaders hold it. Whether they just bought it or it is
 newly tracked cannot be told apart from one snapshot."
```

Rows with `previousHolders > 0` keep the "+N holders" wording, which the data does support.

---

## ISSUE-7 · No rate-limit headers, and a documented `401` that cannot happen

Reproduced: no `RateLimit-*` header on a 200. A client cannot pace itself before the first 429.

The doc also lists `401 unauthorized — the key is missing or wrong`, but the service is keyless,
so that row describes a state that cannot occur.

**Fix:** emit `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` on every response.
Correct the doc's 401 row to say it applies only if `GENIE_API_KEY` is set.

### ✅ Done — 2026-09-08

**The headers were the small half. The limiter itself did not work.**

Adding the headers first exposed it: `RateLimit-Remaining` read `239` on 132 consecutive
calls, and an earlier burst of 400 never produced a 429. The counter was a `Map` in module
scope, and every Edge Function invocation gets a fresh isolate — the map arrived empty and
was discarded on exit. Shipping the header alone would have published a constant dressed as
a budget, which is worse than no header, because a client would have paced against it.

The counter now lives in Postgres (`20260908090000_rate_limits.sql`) and is bumped by
`bump_rate_limit(key, window_seconds)` — one atomic upsert, so two instances cannot
interleave a read-modify-write.

Three things were wrong beyond the reported symptom:

1. **The limit never bound.** Now global rather than per-isolate.
2. **The key moved.** `x-forwarded-for` is a chain (`client, proxy1, …`) and the whole
   header was the key, so anonymous calls scattered across buckets as intermediate hops
   changed — 239, 239, 239, 238, 237, 238, 239, 236 across eight calls. Now the leftmost
   entry, namespaced `key:` / `ip:`.
3. **The 429 carried no budget.** `checkRate` threw instead of returning, so the one
   response that most needs the numbers was the only one without them. Reconstructed in the
   catch.

**Verified live:**

```
250 requests, 12 concurrent, one key ->  240 x 200   10 x 429     (limit binds exactly)
245 requests, 12 concurrent, one key ->  240 x 200    5 x 429
10 sequential on a fixed key         ->  239 238 237 … 230        (monotonic)
429 response                          ->  RateLimit-Limit: 240
                                          RateLimit-Remaining: 0
                                          RateLimit-Reset: 11
                                          RateLimit-Scope: global
                                          Retry-After: 11
```

Headers appear on 200, 400, 404 and 429, and all four are in
`Access-Control-Expose-Headers` so a browser client can read them.

**Fails open.** If the database is unreachable the request is served and `RateLimit-Scope`
reads `unlimited`, because a limiter that turns a database blip into a site-wide outage
costs more than the traffic it guards against. The scope header is what stops a full budget
under failure from being mistaken for a fresh window.

**Cost:** one statement per request, `explain analyze` 3.3ms, table 80kB. Stale rows are
pruned inside the function on ~1% of calls, so it needs no scheduled job.

**Doc:** the 401 row now says it is reachable only when `GENIE_API_KEY` is set, with a note
that the public deployment leaves it unset and the gate is `if (KEY && …)`. A new
"Rate limit headers" section documents all four headers and the fail-open semantics.

---

## ISSUE-8 · ~2s per call, no bulk route

Reproduced: 1.93s, 2.02s, 1.96s.

At 131 traders × 7 sub-routes that is ~900 calls, ~30 minutes sequentially. Most of the 2s is
Edge Function cold start plus a pooled connection, not query time — the same queries run in
150–800ms locally.

**Fix:** `GET /traders?include=pnl,scorecard,portfolio` returning the sub-resources inline, so a
full sync is a handful of calls. A day's work, and the only item here that is a feature rather
than a correction.

---

## ISSUE-9 · `detail` duplicated at two depths

Reproduced. `{"error":{"code","detail"},"detail"}`.

This is deliberate — I kept a top-level `detail` so callers written against the pre-`error`
shape would not break. Nobody is on that shape now.

**Fix:** drop the top-level `detail`, matching the documented body.

### ✅ Done — 2026-09-06

```json
{ "error": { "code": "not_found", "detail": "no trader '…' in the directory" } }
```

Top-level keys are now `['error']` alone. The duplicate existed to protect callers written
against the pre-`error` shape; nobody is on that shape, so it was carrying a cost with no
remaining benefit.

---

## DOC-10 · Doc numbers stale

Confirmed: the doc says 100 traders / 2,038 holdings / 6,398 trades; the service has
131 / 3,272 / 10,180. The doc claims "every value shown below was pulled from the live service",
which invites readers to trust figures that move nightly.

**Fix:** add a `generatedAt` line, refresh the numbers, and label the tables as of-a-date
examples rather than current state. Correct the T3 row per BUG-1.

### ✅ Done — 2026-09-08

`PARAMETER_ROUTES.md` now opens with `Generated: 2026-09-08T06:41Z`, the build it was pulled
from, and the generation count. Every figure in every section was re-pulled live.

The claim that invited the problem is gone. It said *"every value shown below was pulled from
the live service"*, which reads as a guarantee of currency. It now says they are **dated
examples** and tells the reader to re-run the command for today's value.

Headline changes, all from real drift over two days:

```
health          100 traders / 2,038 holdings / 6,398 trades  ->  137 / 3,356 / 12,137
                42,033 transfers  ->  374,927
T6 win rate     56% (14 of 25)    ->  44% (19 wins, 24 losses)
T11 positions   118               ->  97
T13             98.5%             ->  98.7%
T15             166 open, 25 closed -> 320 open, 43 closed
T19             105.2 days        ->  108.4 days
C1 solana       57 of 100         ->  92 of 137
C2 solana       $10,544,636       ->  $35,989,769
```

Four sections needed more than a number swap because the fixes above changed their shape:

- **§4 trust** — rewritten for BUG-2. The example moved from `Natan_benish` to `ogle`, the
  verdict from `implausible` to `self_contradictory`, and the four verdict states and the
  `basis` block are now documented.
- **§7b chains** — each row carries `pricedShare` beside the profit, and the `tier`/`source`
  fields from ISSUE-5 are explained.
- **§3 T17** — the market-cap example moved to `frankdegods` · Stonks, because `unipcs`'s
  largest holdings have no supply resolved and returned `null`.
- **§8 coverage** — the `returnPct` example was `null`; after BUG-1 it is −70.72% on 3 of 43
  trades, which makes the point better than a null did.

All 13 URLs in the doc verified 200, and five refreshed claims spot-checked against live.

---

## Order I would work in

1. **BUG-1** — the only one publishing a number that is pure nonsense
2. **BUG-2** — the only one publishing an accusation
3. **BUG-3, ISSUE-5, ISSUE-6, ISSUE-9** — small, independent, half a day together
4. **ISSUE-4** — needs a decision: average, or rename
5. **ISSUE-7** — headers plus a doc correction
6. **ISSUE-8** — a day, and it is a feature

**BUG-1 and BUG-2 share a root cause worth naming:** **both publish a figure derived from a
denominator we know is incomplete.** The coverage discipline that governs the rest of the API
was not applied to either.

---

## What the report got right that is worth keeping

The probe found no fabricated data, no null-treated-as-zero, and no broken coverage object. The
"what is solid" section matches what I see. Both high-severity items are real, reproducible, and
were found by reading the numbers rather than the code — which is the only way either would have
surfaced.
