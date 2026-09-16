# Five worked examples, one per chain

Everything below is the trader service's own answer, read tonight. Repeat any line with:

```
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/<handle>/aum?window=1m'                  # every chain at once
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/<handle>/aum?window=1m&chain=<chain>'    # one chain
```

"Real point" means a dated figure the answer actually carries — a point whose total is not null. The 30-day answer steps once a day, so 28 real points is 28 drawable days.

The five traders are chosen by one rule, not by taste: only the hundred largest by balance are eligible, because that is who our screens show; for each chain we take the trader whose dollars sit most heavily on that chain, ties going to the one with the most real points on it; chains are taken rarest first and no trader appears twice.

## robinhood — @ethersole

He is worth $1,083,095.27 right now, spread over 2 chains.

| chain | latest total | share of his dollars | real points | first dated figure | last dated figure | the service's word |
| --- | --- | --- | --- | --- | --- | --- |
| robinhood ← | $1,083,092.19 | 100.0% | 18 of 28 | 2026-08-24 $23,921.54 | 2026-09-10 $1,083,092.19 | short_coverage |
| ethereum | $3.08 | 0.0% | 2 of 28 | 2026-09-05 $2.56 | 2026-09-10 $3.08 | too_few_points |

- **Every chain at once**: 2 real points out of 28 daily steps, from 2026-09-05 to 2026-09-10. The refused days say "chains_unrebuildable" (26 days). The service's own drawing flag: false because "too_few_points".
- **robinhood on its own**: 18 real points out of the 28 steps it returns, 2026-08-24 to 2026-09-10, covering 100.0% of his dollars. Flag: false because "short_coverage".
- **Adding his chains up ourselves**: 2 steps where every chain has a figure, 2026-09-05 to 2026-09-10.
- So today the screens can draw **2 days** with every chain on, **18 days** on his best single chain, and **2 days** by adding the chains up.

Repeat: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/ethersole/aum?window=1m` and `…?window=1m&chain=robinhood`

## solana — @zakum (Zakum)

He is worth $1,049,309.52 right now, spread over 2 chains.

| chain | latest total | share of his dollars | real points | first dated figure | last dated figure | the service's word |
| --- | --- | --- | --- | --- | --- | --- |
| solana ← | $1,049,309.52 | 100.0% | 1 of 1 | 2026-09-10 $1,049,309.52 | 2026-09-10 $1,049,309.52 | warming |
| robinhood | no figure | — | 10 of 28 | 2026-08-31 $512.64 | 2026-09-09 $154.7 | no_prices |

- **Every chain at once**: 1 real point out of 28 daily steps, only 2026-09-10. The refused days say "chains_unrebuildable" (27 days). The service's own drawing flag: false because "too_few_points".
- **solana on its own**: 1 real point out of the 1 step that answer even contains, only 2026-09-10, covering 100.0% of his dollars. Flag: false because "warming".
- **Adding his chains up ourselves**: 0 steps where every chain has a figure.
- So today the screens can draw **nothing** with every chain on, **10 days** on his best single chain, and **nothing** by adding the chains up.

Repeat: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/zakum/aum?window=1m` and `…?window=1m&chain=solana`

## bsc — @GeorgeDroid

He is worth $751,008.48 right now, spread over 3 chains.

| chain | latest total | share of his dollars | real points | first dated figure | last dated figure | the service's word |
| --- | --- | --- | --- | --- | --- | --- |
| bsc ← | $668,842.85 | 89.1% | 5 of 28 | 2026-09-01 $31.46 | 2026-09-10 $668,842.85 | short_coverage |
| solana | $76,016.99 | 10.1% | 1 of 1 | 2026-09-10 $76,016.99 | 2026-09-10 $76,016.99 | warming |
| robinhood | $6,148.63 | 0.8% | 28 of 28 | 2026-08-14 $0 | 2026-09-10 $6,148.63 | short_coverage |

- **Every chain at once**: 1 real point out of 28 daily steps, only 2026-09-10. The refused days say "chains_unrebuildable" (27 days). The service's own drawing flag: false because "too_few_points".
- **bsc on its own**: 5 real points out of the 28 steps it returns, 2026-09-01 to 2026-09-10, covering 89.1% of his dollars. Flag: false because "short_coverage".
- **Adding his chains up ourselves**: 1 step where every chain has a figure.
- So today the screens can draw **nothing** with every chain on, **28 days** on his best single chain, and **nothing** by adding the chains up.

Repeat: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/GeorgeDroid/aum?window=1m` and `…?window=1m&chain=bsc`

## ethereum — @Rowdy

He is worth $1,186,083.11 right now, spread over 4 chains.

| chain | latest total | share of his dollars | real points | first dated figure | last dated figure | the service's word |
| --- | --- | --- | --- | --- | --- | --- |
| robinhood | $646,859.97 | 54.5% | 28 of 28 | 2026-08-14 $4,945.19 | 2026-09-10 $646,859.97 | short_coverage |
| solana | $389,524.78 | 32.8% | 1 of 1 | 2026-09-10 $389,524.78 | 2026-09-10 $389,524.78 | warming |
| ethereum ← | $149,638.59 | 12.6% | 13 of 28 | 2026-08-14 $5,105.54 | 2026-09-10 $149,638.59 | short_coverage |
| base | $59.76 | 0.0% | 7 of 28 | 2026-08-29 $73.58 | 2026-09-10 $59.76 | short_coverage |

- **Every chain at once**: 1 real point out of 28 daily steps, only 2026-09-10. The refused days say "chains_unrebuildable" (27 days). The service's own drawing flag: false because "too_few_points".
- **ethereum on its own**: 13 real points out of the 28 steps it returns, 2026-08-14 to 2026-09-10, covering 12.6% of his dollars. Flag: false because "short_coverage".
- **Adding his chains up ourselves**: 1 step where every chain has a figure.
- So today the screens can draw **nothing** with every chain on, **28 days** on his best single chain, and **nothing** by adding the chains up.

Repeat: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/Rowdy/aum?window=1m` and `…?window=1m&chain=ethereum`

## base — @cryptolyxe (lyxe)

He is worth $2,178,763.45 right now, spread over 5 chains.

| chain | latest total | share of his dollars | real points | first dated figure | last dated figure | the service's word |
| --- | --- | --- | --- | --- | --- | --- |
| solana | $1,461,463.31 | 67.1% | 1 of 1 | 2026-09-10 $1,461,463.31 | 2026-09-10 $1,461,463.31 | warming |
| base ← | $715,942.04 | 32.9% | 3 of 28 | 2026-08-19 $455,474.19 | 2026-09-10 $715,942.04 | short_coverage |
| robinhood | $1,346.92 | 0.1% | 28 of 28 | 2026-08-14 $0 | 2026-09-10 $1,346.92 | short_coverage |
| ethereum | $11.17 | 0.0% | 5 of 28 | 2026-08-26 $8.83 | 2026-09-10 $11.17 | short_coverage |
| bsc | no figure | — | 1 of 28 | 2026-09-08 $73.98 | 2026-09-08 $73.98 | no_prices |

- **Every chain at once**: 1 real point out of 28 daily steps, only 2026-09-10. The refused days say "chains_unrebuildable" (27 days). The service's own drawing flag: false because "too_few_points".
- **base on its own**: 3 real points out of the 28 steps it returns, 2026-08-19 to 2026-09-10, covering 32.9% of his dollars. Flag: false because "short_coverage".
- **Adding his chains up ourselves**: 0 steps where every chain has a figure.
- So today the screens can draw **nothing** with every chain on, **28 days** on his best single chain, and **nothing** by adding the chains up.

Repeat: `https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/cryptolyxe/aum?window=1m` and `…?window=1m&chain=base`

## What the five are instances of

- **One refused chain refuses the whole day.** Across the 434 traders we could ask about, the all-chains 30-day answers refuse **8,894 days** with the single word "chains_unrebuildable". That is why four of the five above hold exactly one dated figure with every chain on.
- **The chain with the money is often not the chain with the history.** @GeorgeDroid keeps 89% of his dollars on bsc, which draws 5 days, and 0.8% on robinhood, which draws 28.
- **Asking for solana alone returns one point.** 147 of the 169 solana answers we read contain a single step in total — not a refused series, a series with one step in it. On robinhood that number is 0 of 255.
- **So the top 100 cannot be drawn the way the answer arrives.** 3 of the top 100 by balance can draw a line from the all-chains answer; 98 of them can from one of their own chains.
- **An unpriced chain still costs the whole trader.** @zakum's robinhood and @cryptolyxe's bsc carry no figure at all ("no_prices"), which is enough to make every summed step a gap.

