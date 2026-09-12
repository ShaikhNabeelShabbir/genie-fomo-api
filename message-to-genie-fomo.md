# What we need from your balance and scorecard answers

We are drawing a chart of a trader's balance over time inside our app, and a page showing what he
made day by day. Everything below is your own service's answer, read on the night of 11–12
September 2026: your whole directory, 435 traders, 1,342 requests in all, the bulk of them in one
47-minute run at never more than four a second, nothing refused or rate-limited. No key is sent on
any address below — both routes are open. Every point carries the exact address so you can repeat
it.

The asks are ranked. **The first is worth more than the other seven together.**

---

## 1. Please don't refuse a whole day because one chain couldn't be rebuilt

Asking for a trader's 30-day balance without naming a chain refuses an entire day whenever any
single chain of his cannot be rebuilt. Across the 434 traders we could ask about, **8,894 days**
come back with the one word `chains_unrebuildable` (plus 9 `no_prices` and 2 `wallet_unreadable`).

The result: **109 of 434 traders have the two dated figures a line needs. Ask chain by chain and
309 of 434 do.** Among the hundred largest traders — the ones who fill our screens — it is **3 of
100 against 98 of 100**.

The figures for the refused days are not missing; they are just not in that answer. @ethersole
holds two chains. All-chains, 26 of his 28 days are refused and he is left with 2 dated figures.
Ask for robinhood alone — which is 100% of his money — and 18 dated days come back, 24 August to
10 September, and **16 of them are days the all-chains answer refused**.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/ethersole/aum?window=1m'
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/ethersole/aum?window=1m&chain=robinhood'
```

**What we're asking for:** send the day with what you *can* price, and say what it covers, instead
of refusing it. Your answer already carries, per chain, its latest total and the share of it you
could price, so a partial day need not be a silent one — and whether a caller shows a partial day
is then the caller's decision rather than a missing row.

**What it unlocks:** most traders get a balance chart the first time somebody opens them, instead
of a blank chart with an apology under it.

---

## 2. A close date on each closed trade in the scorecard

Your scorecard already groups realised profit by the date a trade closed — it says so in its own
words: *"realized profit only — closed trades, summed by closed_at"* — and publishes four spans
(24h, 7d, 30d, all). Read for @unipcs on 11 September at 21:24 UTC: 7 days −$81,825.46 over 7
closed trades, 30 days −$131,120.08 over 43.

The per-coin breakdown in that same answer carries 317 coins with 21 fields each, and not one of
them says when a trade closed — the only dates there are about the coin itself, when it was created
and when its supply was read. So you hold the close dates and the answer doesn't carry them.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/unipcs/scorecard'
```

**What we're asking for:** a close date on each closed trade — or, if that answer is already large,
a realised total per day for the last thirty days.

**What it unlocks:** a daily profit line, and a thirty-day calendar that today draws thirty empty
squares because nothing anywhere can say what a trader made on a Tuesday. Nothing needs rebuilding
at your end: you are already summing by that date.

---

## 3. Backfill the balance history — solana first

Of the 8,894 refused days above, solana is the worst chain by a distance. **169 traders hold
solana and only 22 of them can draw a line on it**; 147 of the 169 solana answers contain a single
step in total — not a refused series, a series with one step in it. On robinhood that number is 0
of 255, with a median of 28 dated days out of 28.

It matters because solana is often where the money is. @zakum's entire $1,049,309.52 sits on
solana, and his solana answer is one point.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/zakum/aum?window=1m&chain=solana'
```

**What we're asking for:** rebuild the daily history on solana the way the other four chains
already have it.

**What it unlocks:** for the traders whose money is on solana, a chart instead of a single dot.

---

## 4. What is your "can this be drawn" flag meant to mean?

Every one of the 1,327 balance answers we read says it cannot be drawn — **including all 188 of
them that carry a full 28 dated days**. @unipcs on robinhood has 28 of 28 daily figures and still
comes back `drawable: false`, reason `short_coverage`.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/unipcs/aum?window=1m&chain=robinhood'
```

Any client that waits for that flag draws nothing for anybody. We currently ignore it and use our
own rule — two dated figures is a line, one never is. If the flag means "this doesn't cover the
whole window you asked for", tell us and we'll carry on with our own rule; if it means something we
ought to be honouring, we'd rather know now than draw charts you think are wrong.

---

## 5. The identifier your directory gives us is refused by the balance address

Your directory publishes an identifier for every trader. For @0xangeryy it is
`e398bde0-98f7-47c9-8a43-a8edf967161a` — and the balance address answers 404, "no trader in the
directory", for it, while the same trader answers by handle.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/e398bde0-98f7-47c9-8a43-a8edf967161a/aum?window=1m'   # 404
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/0xangeryy/aum?window=1m'                              # answers
```

We store the identifier, so today every read is a 404 followed by a second read by name. Measured
in one hour: 41 balance reads cost 76 calls, and 13 whole-trader reads cost 26.

**What it unlocks:** half the traffic we send you disappears. If the handle is the identifier you
want us to keep, tell us and we'll store that instead.

---

## 6. Let the batch balance call name a chain

The batch balance call takes up to fifty traders and a window, and there is nowhere in it to name
a chain. Since the history lives in the per-chain answers (ask 1), everything we do per chain is
one call per trader per chain: a screen of fifty traders on one chain is fifty calls where it
could be one.

```
curl -X POST 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/aum' \
  -H 'content-type: application/json' -d '{"ids":["…","…"],"window":"1m"}'
```

**What it unlocks:** charts on lists and leaderboards, not just on one trader's page — and roughly
fifty times less load on you for the same screen.

---

## 7. The one-day window answers nothing for anybody

Asked with `window=1d`, the answer carries no points, no chain list, and the word `warming` — for
every trader we tried: three traders across two separate runs on 11 September, and every trader in
a hand sample of forty earlier the same evening.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/ogle/aum?window=1d'
```

Is that window still filling, or not built yet? Our app offers a one-day button and it draws
nothing for anyone today, so we'd like to know whether to wait or to hide it.

---

## 8. One trader in your directory 404s on the balance address

The directory lists 435 traders. One of them has the handle `yeon__ (gmgn)` — the only one of the
435 with a source name in brackets inside the handle field — and the balance address answers 404
for it. The same person is also listed as plain `yeon__`, which answers normally.

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/yeon__%20(gmgn)/aum?window=1m'   # 404
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/yeon__/aum?window=1m'            # answers
```

One row in 435, and the only trader in your directory we cannot chart at all.

---

## Two notes on the numbers

Your service is still filling: every trader's history starts on 10 September and 144 of the 434
answers said `warming`, so these figures move day by day. The whole run takes about fifty minutes
to repeat, and we're happy to repeat it whenever it's useful to you.

If only one thing on this list is possible, please make it the first. It is the difference between
a quarter of your directory having a chart and three quarters of it — and, for the hundred biggest
traders, between three of them and ninety-eight.

*Attached: the per-chain coverage of the whole directory and of the top hundred; and five worked
traders, one per chain, with every figure and the address to repeat it.*
