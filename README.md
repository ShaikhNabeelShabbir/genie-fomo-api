# genie-fomo API

Resolve a [fomo.family](https://fomo.family) trader to the wallet they **actually trade
from**, then pull that wallet's transactions across Robinhood Chain, Ethereum, BSC, Base
and Solana.

Everything is computed live per request. Nothing is served from a cached resolution.

---

## The problem this solves

fomo publishes an `evmAddress` and an `address` (Solana) for every user. **Those wallets
hold none of the trader's positions.** Verified across all 150 leaderboard accounts: no
transactions on Ethereum, BSC or Base, never funded with SOL, and absent from the holder
list of every token they supposedly own. They appear to be provisioned per-user wallets.

What fomo *does* publish is the exact size of every position — and that is a fingerprint.
Ask the chain who holds that amount of that token, and you get the real wallet:

```
fomo says:   10,957,270.2148 of PONS on Robinhood Chain
chain says:  10,957,873.4194 held by 0x0a6EBEd0…119E      (0.0055% off)

fomo says:   20,400,532.9971 of a second Robinhood token
chain says:  20,402,959.6921 held by 0x0a6EBEd0…119E      (0.0119% off)

two independent tokens, same address  →  confirmed
```

Position sizes carry 12+ significant digits, so a match is effectively unique. Two
independent matches make it certain.

---

> Building or refreshing the directory file? See **[STEPS.md](STEPS.md)** — it covers
> `build_directory.py`, the `FOMO_TOKEN`, and wiring its output into this service.

## Quick start

```bash
npm install
cp .env.example .env        # every key is optional — see Providers
npm run dev                 # http://localhost:8787
./scripts/smoke.sh          # verify it works
```

Production:

```bash
npm run build && npm start
```

Docker:

```bash
docker build -t genie-fomo-api .
docker run -p 8787:8787 --env-file .env genie-fomo-api
```

Node 20+.

---

## Endpoints

| Method | Path | |
| --- | --- | --- |
| GET | `/v1/health` | provider status — check here first when a result looks empty |
| GET | `/v1/traders` | the directory (`?q=`, `?limit=`, `?offset=`) |
| GET | `/v1/traders/:handle/wallets` | **1** — username → real EVM + Solana wallets |
| GET | `/v1/traders/:handle/transactions` | **2** — those wallets → live transactions |

`/transactions` accepts `?chain=robinhood,ethereum,bsc,base,solana`, `?limit=` (per chain,
max 300), `?side=in|out`, `?include_evidence=true`.

### 1 — the real wallets

```bash
curl -s localhost:8787/v1/traders/unipcs/wallets | jq '.resolved_wallets.evm'
```
```jsonc
{
  "address": "0x0a6EBEd0155EDB4b21D92AD02897A626CD90119E",
  "confidence": "confirmed",
  "candidates_considered": 1,          // only one address on-chain held that amount
  "method": "blockscout/none",
  "matches": [
    { "chain": "robinhood", "reported": 10957270.21, "onchain": 10957873.42, "off_by": 0.000055 },
    { "chain": "robinhood", "reported": 20400532.99, "onchain": 20402959.69, "off_by": 0.000119 },
    { "chain": "bsc",       "reported": 22824543.17, "onchain": 24956921.01, "off_by": 0.093,
      "via": "balanceOf" }
  ],
  "notes": ["bsc: Bitquery quota reached"]
}
```

### 2 — their transactions

```bash
curl -s 'localhost:8787/v1/traders/Morris/transactions?chain=solana&limit=20' | jq '.chains'
```

---

## Reading the response

**Confidence is not decoration.**

| | |
| --- | --- |
| `confirmed` | two independent tokens agreed on the same address — trust it |
| `high-candidate` | one tight, unrivalled match — very likely right |
| `ambiguous` | several addresses within tolerance, nothing to break the tie |
| `unresolved` | no holder matched the reported amount |
| `no-evm-holdings` / `no-sol-holdings` | nothing to resolve on that chain |

`/transactions` **only scans `confirmed` and `high-candidate` addresses.** Anything weaker
comes back with `skipped: true` and a note. Attributing someone else's transactions to a
trader is worse than returning nothing.

**Always read `chains[]` before trusting an empty list:**

```jsonc
{ "chain": "ethereum", "count": 0, "error": null }                // no activity
{ "chain": "bsc", "count": 0, "error": "Bitquery quota reached" } // could not look
```

Those are different answers. Collapsing them is the fastest way to ship wrong data.

**A large `off_by` is not a bad match.** The directory is a snapshot and active traders
keep trading, so a position can drift. Above, two matches are ~0.01% off and one is 9.3%
— the tight ones pin the wallet, the loose one corroborates it.

---

## Providers

| Chain | Address resolution | Transactions | Key |
| --- | --- | --- | --- |
| Robinhood | Bitquery → Blockscout | Blockscout | none |
| Ethereum | Bitquery → Blockscout | Etherscan | `ETHERSCAN_KEY` |
| BSC | Bitquery only | Bitquery | `BITQUERY_KEY` |
| Base | Bitquery only | Bitquery | `BITQUERY_KEY` |
| Solana | Helius | Helius | `HELIUS_SOLANA_KEY` |

**Every key is optional.** The service reports what it can reach at `/v1/health` and
degrades per-chain rather than failing.

Bitquery is preferred for resolution because it filters holders by balance range
server-side, so position size is irrelevant and all four EVM chains are covered. When the
key is missing **or out of points**, resolution falls back to Blockscout automatically —
free and keyless, but it only pages the top ~100 holders, so it finds large positions and
misses small ones. The fallback is reported in `method` and `notes`, never hidden.

BSC and Base have no free substitute: Etherscan's free tier refuses both chains,
Blockscout has no BSC instance and its Base one returns 500s, and public BSC RPCs require
an archive token for historical logs.

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WALLETS_FILE` | `./data/wallet.full.data.json` | trader directory to serve |
| `ETHERSCAN_KEY` | — | Ethereum transactions |
| `HELIUS_SOLANA_KEY` | — | Solana resolution + transactions |
| `BITQUERY_KEY` | — | EVM resolution, BSC/Base transactions |
| `GENIE_API_KEY` | — | optional, off by default; set it to require an `X-API-Key` header |
| `PORT` | `8787` | |

Read from `.env` in this directory.

---

## The directory file

`WALLETS_FILE` holds the traders to serve: handle, display name, and `topHoldings`
(token + chain + exact position size). A copy ships in `./data` so the service runs
immediately.

It is produced by `build_directory.py` (included here — see **[STEPS.md](STEPS.md)**),
which reads the fomo leaderboard. Any resolution fields present in the file are **ignored** — this service
resolves live. To refresh, drop in a newer file; it is re-read automatically when its
mtime changes, so no restart is needed.

Minimum shape:

```jsonc
{
  "traders": [
    {
      "handle": "unipcs",
      "name": "Unipcs",
      "rank": 44,
      "evm": "0x…",                    // fomo's provisioned wallet, for reference only
      "sol": "…",
      "holdings": [
        { "tokenAddress": "0x39db…", "networkId": 4663, "humanAmount": 10957270.21 }
      ]
    }
  ]
}
```

`networkId`: `4663` Robinhood · `1` Ethereum · `56` BSC · `8453` Base · `1399811149` Solana.

---

## Layout

```
src/
  server.ts        express app, routes, auth
  directory.ts     loads the directory, reloads on mtime change
  resolvers.ts     live resolution — Bitquery → Blockscout, Helius
  transactions.ts  Etherscan, Blockscout, Bitquery, Helius fetchers
  settings.ts      env + chain config
scripts/smoke.sh   end-to-end check against a running instance
data/              the shipped directory file
```

No runtime dependencies beyond `express` and `cors`; every provider call uses Node's
built-in `fetch`.

---

## Operational notes

**Resolution is the slow part** — 4–30s per trader, since it queries holders for each
position and confirms with `balanceOf`. Transactions are sub-second once the address is
known.

**There is no cache.** Add a TTL cache keyed on `(handle)` for resolutions and
`(wallet, chain)` for transactions before exposing this to anything that retries: Helius
bills 100 credits per transaction pull, Bitquery meters points, and Blockscout starts
returning 403 Cloudflare challenges under sustained load. The service retries those with
backoff, but caching is the real fix.

**There is no authentication by default** — every route is open. Setting `GENIE_API_KEY`
turns on an `X-API-Key` check with no code change; see `PROD-STEPS.md` → Future hardening.
There is no rate limiting either, so put it behind a gateway before exposing it publicly.
