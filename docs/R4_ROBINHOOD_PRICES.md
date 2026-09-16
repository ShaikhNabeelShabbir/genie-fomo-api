# R4 — pricing Robinhood-chain coins (network_id 4663)

Measured 2026-09-16/17 from this repo, no keys. Consumer ask: `docs/consumer/genie-fomo-fix-request-v2-16-sep.md` §2 R4, Appendix C §B.

## What prices a Robinhood coin today

Three sources, in the order every reader coalesces them (`scripts/load_aum_samples.mjs pricesFor`, `load_chain_balances.mjs`, `aum-sample/index.ts`):

1. `quote_assets.pegged_usd` — USDG `0x5fc5…d168` = 1. WETH `0x0bd7…ad73` and native ETH `0x0000…0000` are floating rows; `load_quote_prices.mjs` prices ETH from Binance into `token_prices`.
2. `token_info.price_usd` — GMGN `/v1/token/info?chain=robinhood`, `load_token_info.mjs` (needs `GMGN_API_KEY`, 1 req/s). Covers the coins GMGN indexes; the consumer saw Lasercat397's DOGEGPT `0x26becab467bf74a3e09c095c30427acbd6544608` priced this way ($58,631).
3. `token_prices` — daily closes. Before this change only Binance quote assets were ever written here.

## Why 28 of 39 refused chains price under 5%

The local directory holds 600 distinct Robinhood tokens across 1,873 positions; fomo itself prices 660 positions, nearly all one token. Everything else waits on GMGN, and GMGN's Robinhood index is a thin slice of a chain where memecoins launch by the hundred (Bags bonding curve → Uniswap v4). A wallet with 40 such coins and one NVDA prices at 2.5% by count and is refused `too_little_priced`; `baolingd` 437/440 unpriced is that shape.

## Candidate sources, each tested with one real request

| # | Source | Request | Verbatim answer |
|---|---|---|---|
| i | on-chain, `eth_call` on `rpc.mainnet.chain.robinhood.com` | `slot0()` on NVDA/USDG v3 pool `0xd4EB…14a3` | `0x…010b1d3961509b96eec07a4a3140b7…`, token0 USDG (6 dec) token1 NVDA (18) → **213.858 USDG**; `getReserves()` on ROL/WETH v2 pair `0x3e1e…b3AC` → 0.0350 WETH / 136,212 ROL → **2.5719e-7 WETH**. Factories learned from the pools: v3 `0x1f7d7550b1b028f7571e69a784071f0205fd2efa`, v2 `0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f`. |
| ii | Blockscout token API `robinhoodchain.blockscout.com/api/v2/tokens/0x26bec…4608` | GET | **HTTP 403**, body `<title>Just a moment...</title>` (Cloudflare challenge; same as `chain_reads.mjs` records) |
| iii | GMGN `openapi.gmgn.ai/v1/token/info?chain=robinhood&address=0x26bec…4608` | GET, no key | **HTTP 401** `{"code":401,"error":"AUTH_INVALID","message":"missing api key or client_id"}` — with the nightly's key this is what `load_token_info.mjs` already runs; the gap is coverage, not access |
| iv | DexScreener `api.dexscreener.com/tokens/v1/robinhood/<a,b,…>` | GET, no key, 30 addresses/call | **HTTP 200**, 10 of 11 held tokens priced: CAVEHORSE `0xc48a…84ed` 0.000131 USD (uniswap v4, liq $32,704); NVDA 213.76 (v3); AI 0.2692 (v4); ROL 0.000617 (v2); GOOGL, SPCX, AAPL, NASTY, WETH 2395.60. DOGEGPT `0x26bec…4608`: `{"schemaVersion":"1.0.0","pairs":null}` (honeypot, no pool — GMGN still prices it). |

On-chain and DexScreener agree: NVDA 213.858 vs 213.76 (0.05%), ROL 2.5719e-7 vs 2.571e-7 WETH.

## Recommendation: DexScreener (iv), written to `token_prices` as source `dexscreener:<dex>:<version>`

- The on-chain read works and is exact, but it needs pool *discovery* first: v2/v3 via `factory.getPool`, and v4 — where Bags graduates every memecoin and half the volume sits — only via `PoolManager` `Initialize` log scans, on an RPC that 429s for minutes after a few `eth_getLogs` (the spike above lost ~10 min to one). Three pool readers plus a log scanner to reproduce one HTTP call.
- Blockscout is Cloudflare-blocked; GMGN is the source whose coverage is the problem.
- DexScreener is keyless, 30 tokens per call, 300 calls/min: the 600 held tokens are 20 calls. The daily row lands as `token_prices_daily` in `/positions` and the sampler with no new vocabulary word.

Ceiling: DexScreener is a third party with no SLA; if it goes away, (i) is the fallback and the factories above are the starting point. Tokens on a bonding curve (no pool yet) stay unpriced from either source.

Loader: `scripts/load_robinhood_prices.mjs` (`--dry-run`, `--limit N`, `--token 0x…` skips the DB), nightly after `load_quote_prices.mjs`.
