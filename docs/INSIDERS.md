# Insiders — finding wallets that know something

## 1. What we are actually looking for

A wallet that **buys a token very early, sells it soon after at a large multiple — and does
this again and again.**

```
token release  ──Δt₁──>  buys in  ──Δt₂──>  sells out
                       (entry price)      (exit price → profit)
```

Four components:

| | Component | Signal on its own |
| --- | --- | --- |
| 1 | Bought early (Δt₁ small) | ❌ none — see §3 |
| 2 | Sold fast (Δt₂ short) | ❌ weak |
| 3 | Large multiple (exit ÷ entry) | ❌ weak |
| 4 | **Did it repeatedly** | ✅ **this is the signal** |

**One early, fast, profitable trade is luck. Fourteen is a pattern.** Components 1–3
describe a single trade and can happen to anyone. Only repetition separates knowledge from
chance, and every metric here is built around that.

---

## 2. Why the obvious approach fails

The intuitive method — *rank wallets by how fast they bought after launch* — does not work.
We traced a real launch to check.

**Token PONS**, mint `iG8wRS2S8LRVQQnUhYTDmbv5i9VF9tGQzbTo65Ppump`, created
`2026-09-03T05:37:49Z`, now ~$6.76M market cap:

```
99 distinct wallets bought within the first 60 seconds
the earliest buys landed at the exact creation second
```

Ninety-nine wallets. One of them was `27HFmP7ccLadGswv…` — the wallet that topped our
pump.fun volume board with **1,745 trades**.

**Earliness is not scarce.** The first minute of any launch is a stampede of sniper bots
running scripts. Rank by speed and you get a list of scripts.

---

## 3. The real discriminator: selectivity

Snipers and insiders both arrive early. They differ in **how often they are right**.

| | Early buys | Profitable | What it means |
| --- | --- | --- | --- |
| **Sniper bot** | ~1,000 launches | ~1% | Buys *everything*. Fast, not informed. |
| **Informed wallet** | ~15 launches | ~80% | Buys *selectively*. Chose these. |

A wallet early on 1,200 tokens has a script. A wallet early on 12 tokens **and right on
10** knew something.

So the primary metric is not speed. It is **hit rate on early buys**, gated by a repeat
count.

---

## 4. How we actually classify a wallet

### The tempting rule, and why it is not enough

> *"Find who bought early and sold at a good profit — those are the insiders."*

This is the right **filter**, but it cannot be the **verdict**. It is a test on a *trade*;
sniper-vs-insider is a property of a *wallet*.

A sniper who enters 1,000 launches and hits 1% produces **ten** early-and-profitable
trades. Every one passes the rule.

| | Early buys | Hit rate | Trades passing the rule |
| --- | --- | --- | --- |
| Sniper | 1,000 | 1% | **10** ✅ |
| Insider | 12 | 83% | **10** ✅ |

Identical output — and the sniper may rank higher, since ten winners drawn from a thousand
attempts are likely larger than ten drawn from twelve.

The rule never sees the sniper's **990 losses**, because it only inspects trades that
already worked. That is survivorship bias built into the filter.

**The fix is one extra question:** divide by the wallet's *total* early buys.

```
filter:   early buy + sold at profit          ->  candidate trade
verdict:  candidates ÷ ALL early buys by that wallet
```

Sniper: 10 ÷ 1,000 = **1%**. Insider: 10 ÷ 12 = **83%**. The numerator is identical; only
the denominator separates them.

> **Do not ask "did they win?" Ask "how often did they win?"**

### The classifier

Two axes. Either one alone fails.

```
                    hit rate (how often right)
                              ^
                         high |  INSIDER          |  investigate
                              |  few bets,        |  many bets, all right
                              |  mostly right     |  -> too good: data error
                              |                   |     or elite bot
                    ----------+-------------------+---------->
                              |  NOISE            |  SNIPER
                          low |  too few bets     |  many bets,
                              |  to judge         |  rarely right
                                  low          high
                                    early buys (how many bets)
```

| | Parameter | Computed from |
| --- | --- | --- |
| **P1** | `early_buys` = N — tokens entered inside the early window | `createdAt` vs token creation |
| **P2** | `early_wins` = W — of those, how many closed in profit | `realizedPnlUsd > 0` |
| **P3** | **`hit_rate` = W ÷ N** — the discriminator | — |
| **P4** | `selectivity` = N ÷ launches available | how many chances they passed up |

### Decision rule

```
N >= 5    and  hit_rate >= 60%  and  N < 200   ->  INSIDER
N >= 200  and  hit_rate <  20%                 ->  SNIPER
N >= 200  and  hit_rate >= 60%                 ->  INVESTIGATE
N <  5                                         ->  INSUFFICIENT EVIDENCE
```

**Both bounds on N are load-bearing.** Without the ceiling, a busy enough bot satisfies
"5 wins at 60%" by brute force on some subset of its thousand attempts.

### Confirming signals — cheap, and they catch scripts directly

| | Signal | Sniper | Insider |
| --- | --- | --- | --- |
| **P5** | **Timing variance** — `stdev(Δt₁)` | ~0, metronomic (always 2–4s) | scattered |
| **P6** | Size uniformity — `stdev(size) ÷ mean(size)` | ~0, fixed position size | varies with conviction |
| **P7** | Hours active — distinct hours-of-day | all 24 | has a sleep gap |

**P5 is the strongest.** A script reacts to an event at a near-constant delay; a human
deciding takes variable time. Near-zero timing variance is a script *regardless of hit
rate*.
