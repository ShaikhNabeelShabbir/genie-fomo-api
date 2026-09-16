# Launch metadata (workflow gap 3: created-at, launchpad, curve, graduation)

Measured 17 Sep 2026 against the keyless public RPC (`https://api.mainnet-beta.solana.com`,
no `HELIUS_SOLANA_KEY` in the environment). Loader: `scripts/load_token_launch.mjs`.

## pump.fun, on chain (Solana)

Program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Bonding-curve PDA = `["bonding-curve", mint]`,
derived with `scripts/lib/solana_pda.mjs` (no @solana/web3.js: base58 + sha256 + the ed25519
off-curve test). Self-check: the `["global"]` PDA equals `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`.

Account layout (Anchor, little-endian; verified on three live accounts, `space` 115 and 151):
`disc[8] = 17 b7 f8 37 60 d8 ac 60` · `virtual_token_reserves u64 @8` · `virtual_sol_reserves u64 @16` ·
`real_token_reserves u64 @24` · `real_sol_reserves u64 @32` · `token_total_supply u64 @40` ·
`complete bool @48` · `creator pubkey @49`. Later fields (mayhem mode etc.) follow; we do not read them.

The global config (`4wTV…`, offsets 73/81/89/97) answered verbatim:
`initial_virtual_token_reserves 1073000000000000 · initial_virtual_sol_reserves 30000000000 ·
initial_real_token_reserves 793100000000000 · token_total_supply 1000000000000000 · fee_basis_points 95`,
so `progress = 1 - real_token_reserves / 793_100_000e6` and `graduated = complete`.

Verbatim reads (`getAccountInfo`, base64):

| mint | curve PDA | real_token_reserves | complete | progress |
|---|---|---|---|---|
| `2NEPGSZ3GUiWL7ZYRyrnSveFNqvewAy3oEGK7Zxapump` (minutes old) | `DgUkPv3uSN9HLKgYd36sh26koyPLRNXYQ4k2Fxzi7t1R` | 793100000000000 | false | 0 |
| `iG8wRS2S8LRVQQnUhYTDmbv5i9VF9tGQzbTo65Ppump` (PONS) | `B14UGdKJR4jEs8q6GYUA9vSi1NKZa7fHnNGTf9tMFrqA` | 0 | true | 1 |
| `Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump` | `3Sg92V4Mre9Apm7dJsM39B6vrAEVVErE1vBsZMKyUbxT` | 0 | true | 1 |

A mint with no curve account (`value: null`) is not a pump.fun launch: `launchpad` stays null.
After graduation the curve zeroes its reserves and keeps `complete = true`; the PumpSwap pool
(DexScreener `dexId: pumpswap`, e.g. `HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3` for Ai66,
`pairCreatedAt` 8 min after launch) is the migration target. `complete` alone is enough.

## Creation time

`getSignaturesForAddress(curvePda)` walked to the oldest page: PONS oldest `blockTime 1788413869`
= `2026-09-03T05:37:49Z`, the second `docs/INSIDERS.md` recorded from the launch itself; 2NEP
`1789590861` = DexScreener's `pairCreatedAt` for its `pumpfun` pair, to the second. Cost: one page
(1,000 signatures, ~1.5–5 s public) for a fresh or fast-graduated token; 20 pages / 31 s for Ai66.
Rejected: DexScreener `pairCreatedAt` (the `pumpfun` pair disappears after graduation; PONS answers
`[]`), the Metaplex metadata PDA's history (0 signatures on the public index for two of three mints,
and Ai66's oldest is a later update), Helius DAS `getAsset` (no created-at field, and no key here).
The loader walks at most `MAX_SIG_PAGES = 20` pages and leaves `created_at` null past that, once:
a graduated token is never re-read, so the cost is paid one time per mint.

## EVM (not implemented)

Contract creation block needs either a paid indexer, Blockscout (403 to non-browsers on robinhood),
or `eth_getLogs` from genesis, which the public RPCs cap. Cheapest honest path when wanted:
DexScreener `pairCreatedAt` of the deepest pool (`scripts/lib/dexscreener.mjs` already fetches
it, 30 tokens per call) as `created_at` with a `launchpad` of null, and Etherscan-family
`contract/getcontractcreation` (keyed) for the true deploy block. Later.
