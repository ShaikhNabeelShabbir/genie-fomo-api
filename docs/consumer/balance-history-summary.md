# How much balance history genie-fomo really holds, per chain, across the whole directory

Measured 11–12 September 2026, between 05:41 and 06:31 UTC. Every figure below is the trader service's own answer; nothing is filled in, joined up or guessed.

## The exact addresses used, so anybody can repeat this

```
# the directory: three pages of 200, following nextCursor; 435 traders, every one with a handle, none twice
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders?limit=200'
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders?limit=200&cursor=<nextCursor from the page before>'

# one trader's balance over 30 days, every chain at once (this is what carries chains[])
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/<handle>/aum?window=1m'

# the same trader, one chain at a time, for each chain his all-chains answer listed
curl 'https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api/v1/traders/<handle>/aum?window=1m&chain=<base|bsc|ethereum|robinhood|solana>'
```

No key is sent: both addresses are open. A trader must be named by his HANDLE — the directory's own id answers 404 "no trader in the directory". The directory carries no balance, so "the top 100 by balance" below is ranked on the latest total each trader's own all-chains answer reports.

Cost to the service: **1,342 requests** in all — 6 by hand to check the shape of the answers, 3 for the directory, 12 on a three-trader trial, 1,316 for the run itself, 3 to repeat two reads (one hit a network blip; my first repair then wrote the answer into the wrong row, so both were asked again and replaced), and 2 at the end to check two cells of this table against the live service by hand (both matched). Never more than four a second, at most three in flight, and a pause between traders. Not one request was refused or rate-limited, and nothing was retried hard.

One trader in the directory, **`yeon__ (gmgn)`**, cannot be asked about at all: the balance route answers 404 "no trader in the directory" for him, because what the directory lists as his handle is not a handle that route knows. He is left out of every count below, so the counts are out of 434.

## What the words mean here

- **Real point** — a dated figure the answer actually carries (a point whose total is not null). Refused points are not counted and are never read as zero.
- **Can draw** — two or more real points, which is the owner's rule (one point is never a line).
- **Days** — the 30-day answer steps once a day and returns 28 steps, so one real point is one drawable day.
- **Every chain on** — reported two ways, because they are different answers: what the service's own all-chains answer holds, and what ADDING UP the per-chain answers gives, where a step counts only when every chain has a figure at it (the rule #211 will draw by).
- **Best single chain** — the chain of his with the most real points.

### The whole directory (434 traders)

| question | answer |
| --- | --- |
| Can draw a line (2+ real points) from the service's own ALL-CHAINS answer | **109 of 434** (25.1%) |
| Can draw a line by ADDING UP every chain (a step needs every chain present) | **128 of 434** (29.5%) |
| Can draw a line from their BEST SINGLE CHAIN | **309 of 434** (71.2%) |
| Can draw nothing either way | 101 of 434 (23.3%) |
| Can draw a line if we take whichever of the two answers is LONGER | **333 of 434** (76.7%) |
| Traders whose all-chains answer beats every single chain of theirs | 83 of 434 — 24 of them can draw ONLY that way |
| Median real points, all-chains answer | 1 |
| Median real points, best single chain | 16 |
| Median real points, chains added up | 1 |
| Median real points, whichever answer is longer | 17 |
| Median days spanned, all-chains answer | 0 |
| Median days spanned, best single chain | 24 |
| Median chains held | 2 |
| Median share of a trader's dollars sitting on chains that can draw | 99.9% |
| Traders where the drawable chains cover 90%+ of their dollars | 214 of 434 (49.3%) |
| Traders where the drawable chains cover nothing | 49 of 434 (11.3%) |
| Traders holding at least one chain the service cannot price | 50 of 434 |
| Traders with no current balance figure at all | 14 of 434 |
| Traders whose all-chains answer holds no dated figure at all | 7 of 434 |

| chain | traders holding it | can draw on it alone | median real points | most points seen | median share of the holder's dollars | unpriced for |
| --- | --- | --- | --- | --- | --- | --- |
| robinhood | 255 | 252 (98.8%) | 28 | 28 | 79.2% | 23 |
| ethereum | 239 | 194 (81.2%) | 4 | 27 | 0.0% | 18 |
| bsc | 189 | 174 (92.1%) | 6 | 25 | 5.2% | 4 |
| solana | 169 | 22 (13.0%) | 1 | 28 | 32.2% | 0 |
| base | 41 | 36 (87.8%) | 4 | 18 | 0.0% | 8 |

Refused days in the all-chains answers of this group: chains_unrebuildable — 8894 days, no_prices — 9 days, wallet_unreadable — 2 days.

Status word on the all-chains answer: ready — 290, warming — 144.

The service's own "can this be drawn" flag on the all-chains answer: false / too_few_points — 281, false / short_coverage — 80, false / warming — 64, false / no_prices — 8, false / wallet_unreadable — 1.

The top 100 below are the hundred largest of those 434 by their current total; the hundredth is worth $729,031 and the largest, @unipcs, $15,665,319.

### The top 100 by balance (what the screens show) (100 traders)

| question | answer |
| --- | --- |
| Can draw a line (2+ real points) from the service's own ALL-CHAINS answer | **3 of 100** (3.0%) |
| Can draw a line by ADDING UP every chain (a step needs every chain present) | **5 of 100** (5.0%) |
| Can draw a line from their BEST SINGLE CHAIN | **98 of 100** (98.0%) |
| Can draw nothing either way | 2 of 100 (2.0%) |
| Can draw a line if we take whichever of the two answers is LONGER | **98 of 100** (98.0%) |
| Traders whose all-chains answer beats every single chain of theirs | 0 of 100 — 0 of them can draw ONLY that way |
| Median real points, all-chains answer | 1 |
| Median real points, best single chain | 28 |
| Median real points, chains added up | 1 |
| Median real points, whichever answer is longer | 28 |
| Median days spanned, all-chains answer | 0 |
| Median days spanned, best single chain | 28 |
| Median chains held | 4 |
| Median share of a trader's dollars sitting on chains that can draw | 94.9% |
| Traders where the drawable chains cover 90%+ of their dollars | 55 of 100 (55.0%) |
| Traders where the drawable chains cover nothing | 3 of 100 (3.0%) |
| Traders holding at least one chain the service cannot price | 7 of 100 |
| Traders with no current balance figure at all | 0 of 100 |
| Traders whose all-chains answer holds no dated figure at all | 0 of 100 |

| chain | traders holding it | can draw on it alone | median real points | most points seen | median share of the holder's dollars | unpriced for |
| --- | --- | --- | --- | --- | --- | --- |
| robinhood | 98 | 98 (100.0%) | 28 | 28 | 85.0% | 1 |
| solana | 95 | 7 (7.4%) | 1 | 28 | 10.7% | 0 |
| ethereum | 84 | 82 (97.6%) | 5 | 13 | 0.0% | 0 |
| bsc | 76 | 72 (94.7%) | 7 | 25 | 0.0% | 2 |
| base | 31 | 29 (93.5%) | 5 | 18 | 0.0% | 4 |

Refused days in the all-chains answers of this group: chains_unrebuildable — 2680 days.

Status word on the all-chains answer: ready — 98, warming — 2.

The service's own "can this be drawn" flag on the all-chains answer: false / too_few_points — 98, false / short_coverage — 2.

### Asking for one chain is not the same as asking for all of them

107 traders in the directory hold exactly one chain, so their all-chains answer and their single-chain answer are about the same dollars.

| their only chain | traders | median real points, all chains | median real points, that chain asked alone | traders who LOSE history by asking per chain |
| --- | --- | --- | --- | --- |
| solana | 43 | 1 | 1 | 9 |
| robinhood | 25 | 4 | 17 | 0 |
| ethereum | 24 | 1 | 2 | 0 |
| bsc | 14 | 1 | 4 | 0 |
| base | 1 | 0 | 0 | 0 |

| chain asked alone | answers | median steps the answer contains | answers containing a single step |
| --- | --- | --- | --- |
| robinhood | 255 | 28 | 0 (0.0%) |
| ethereum | 239 | 28 | 3 (1.3%) |
| bsc | 189 | 28 | 6 (3.2%) |
| solana | 169 | 1 | 147 (87.0%) |
| base | 41 | 28 | 3 (7.3%) |

### What I read out of this (mine, not the service's)

1. **Per chain is the right read, but it must not be the only read.** Asking each chain separately takes the directory from 109 traders who can draw to 309. But 83 traders have MORE history in their all-chains answer than in any single chain of theirs, and 24 of those can draw only that way. Keeping both reads and taking whichever is longer covers 333 of 434.
2. **Summing every chain is the weakest of the three.** Because a step needs every chain present, adding them up leaves only 128 of 434 drawable — barely better than the all-chains answer and far behind one good chain. So the chain switches matter more than the sum: the default selection should not be "every chain on" if that draws nothing while one switch draws a month.
3. **The one thing to ask the genie-fomo team for, in order.** First, stop refusing a whole day because one chain cannot be rebuilt — 8,894 days are refused that way across the directory, and the per-chain answers prove the service already holds the figures for the other chains on those very days. Second, give solana the same rebuilt history the other four chains get when asked alone: 147 of 169 solana answers come back with a single step, and solana is the largest chain for much of the top 100.

