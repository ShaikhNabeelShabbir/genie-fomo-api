# STEPS — building the directory and running the API

End-to-end: pull the fomo leaderboard, produce the directory file, serve it.

```
  build_directory.py            the API
  ──────────────────            ───────
  fomo leaderboard              reads the directory file
  (needs FOMO_TOKEN)            resolves each trader LIVE on request
        ↓                       returns real wallets + transactions
  data/wallets.json  ─────────────────────↑
  raw/leaderboard.json (kept for --offline reruns)
```

The script only supplies **inputs** — handles, display names, and `topHoldings` (token +
chain + exact position size). It never finds a real wallet. That happens live inside the
API, on every request, so responses reflect the chain now rather than a snapshot.

---

## Prerequisites

**For `build_directory.py`** — Python 3 and exactly one external package:

```bash
pip install requests
```

Everything else it imports (`json`, `os`, `pathlib`, `sys`, `time`) is standard library.
No virtualenv is required, though one is tidier.

**For the API** — Node 20+ and `npm install`.

The two are independent: the script is a one-off you run occasionally, the API is a
long-running service. The API needs no Python at all.

---

## Step 1 — Get a FOMO_TOKEN

The leaderboard is a private endpoint, so the script borrows your logged-in session.

1. Open <https://fomo.family> and log in.
2. DevTools → **Application** → **Cookies** → `https://fomo.family`.
3. Copy the value of **`privy-token`**.

It expires in roughly **an hour**, so grab it immediately before running the script. It is
a personal credential — never commit it, never ship it in a deployed app. It is used only
here, on your machine; the API never sees it.

> The script sends the token as `Authorization: Bearer …`, not as a cookie. The cookie
> form overflows the server's header limit and returns **HTTP 431**. If you adapt this
> code elsewhere, keep the Bearer form.

---

## Step 2 — Build the directory

Run **from this directory** — the script writes to `./data` and `./raw` relative to your
current working directory.

```bash
cd api-ts
export FOMO_TOKEN="paste-the-privy-token-here"
python3 build_directory.py
```

Output:

```
data/wallets.json        the directory
raw/leaderboard.json     the untouched API response
```

### Options

| Env var | Default | |
| --- | --- | --- |
| `WINDOW` | `30d` | leaderboard window: `24h`, `7d`, `30d` |
| `TOP_N` | `150` | how many traders to keep |

```bash
WINDOW=7d TOP_N=50 python3 build_directory.py
```

### Rerunning without a token

`raw/leaderboard.json` is kept so you can rebuild without a fresh token:

```bash
python3 build_directory.py --offline
```

This only works **after** at least one live run — offline mode reads that dump, so on a
clean checkout it exits with:

```
Set FOMO_TOKEN (your fomo.family privy-token) and rerun, or drop a
leaderboard dump at raw/leaderboard.json for --offline.
```

It rebuilds from data already on disk, so it produces the same traders as the last live
pull, not fresher ones.

---

## Step 3 — Point the API at the output

**The filenames do not match, and this is the step people miss.**

| | |
| --- | --- |
| the script writes | `data/wallets.json` |
| the API reads by default | `data/wallet.full.data.json` |

So a successful script run does **not** change what the API serves until you connect them.
Pick one:

```bash
# A — tell the API where to look (preferred; keeps both files)
echo 'WALLETS_FILE=./data/wallets.json' >> .env

# B — overwrite the shipped file
cp data/wallets.json data/wallet.full.data.json
```

Confirm which file is actually loaded:

```bash
curl -s localhost:8787/v1/health | jq '.directory'
```

```jsonc
{ "file": "/…/api-ts/data/wallets.json", "traders": 150, "window": "30d",
  "generated_at": 1788018815 }
```

If `file` is not what you expect, the API is serving something else.

---

## Step 4 — Run the API

```bash
npm install
cp .env.example .env        # add whichever provider keys you have
npm run dev                 # http://localhost:8787
```

Every provider key is optional; `/v1/health` reports what is reachable and the service
degrades per-chain rather than failing. See `README.md` for the full provider table.

---

## Step 5 — Verify

Fastest check that everything is wired:

```bash
./scripts/smoke.sh
```

```
health responds                    ok
directory has traders              ok
trader list responds               ok
unknown handle is 404              ok
wallets resolves unipcs            ok
transactions responds              ok
all checks passed
```

The rest of this section walks every route individually — what it does, how to call it,
and what to look for in the reply. All output below is real.

---

### `GET /v1/health` — is anything actually reachable?

Reports which directory file is loaded and which providers are configured. **Check this
first whenever a result looks empty**, because an empty answer caused by a missing key
looks identical to one caused by a wallet having no activity.

```bash
curl -s localhost:8787/v1/health | jq
```

```jsonc
{
  "status": "ok",
  "runtime": "typescript",
  "directory": {
    "file": "/…/api-ts/data/wallet.full.data.json",   // confirm this is the file you expect
    "traders": 150,
    "window": "30d",
    "generated_at": 1788018815
  },
  "providers": {
    "etherscan":  { "configured": true, "serves": ["ethereum transactions"] },
    "blockscout": { "configured": true, "serves": ["robinhood transactions", "…holder lists"] },
    "helius":     { "configured": true, "serves": ["solana address resolution", "…transactions"] },
    "bitquery":   { "configured": true, "serves": ["evm address resolution", "bsc/base transactions"] }
  }
}
```

Look for: `traders` greater than 0, and `file` pointing at the directory you built in
Step 3. `blockscout` is always `true` — it needs no key.

---

### `GET /v1/traders` — who is in the directory?

Lists the traders available to look up. A plain file read: instant, free, no chain calls
and no API keys. Use it to discover valid handles for the other two endpoints.

Query params: `q` (matches handle or display name), `limit` (default 25, max 200),
`offset`.

```bash
curl -s 'localhost:8787/v1/traders?q=uni&limit=2' | jq
```

```jsonc
{
  "total": 1,          // matches for this query, not the page size
  "limit": 2,
  "offset": 0,
  "traders": [
    { "handle": "unipcs", "name": "Unipcs", "rank": 44,
      "pnl_30d": 3073576.99, "holdings": 3 }
  ]
}
```

`holdings` is how many positions fomo reports — and therefore how many chances the
resolver has to find the wallet. A trader with 1 holding can never reach `confirmed`,
which needs two independent tokens agreeing.

Paging:

```bash
curl -s 'localhost:8787/v1/traders?limit=5&offset=10' | jq '.traders[].handle'
```

---

### `GET /v1/traders/:handle/wallets` — ENDPOINT 1: the real wallets

**What it does:** takes the trader's reported positions, asks each chain who holds those
exact amounts, and returns the address that matches — the wallet they actually trade from.
Resolved live on every call; nothing cached.

Slow by nature (**4–30s**): it queries holder lists per position and confirms with
`balanceOf`. This is the expensive endpoint.

```bash
curl -s localhost:8787/v1/traders/unipcs/wallets | jq '.resolved_wallets.evm'
```

```jsonc
{
  "address": "0x0a6EBEd0155EDB4b21D92AD02897A626CD90119E",
  "confidence": "confirmed",
  "candidates_considered": 1,        // only one address on-chain held that amount
  "best_off_by": 0.000055,
  "method": "blockscout/none",       // which providers answered
  "matches": [
    { "chain": "robinhood", "reported": 10957270.21, "onchain": 10957873.42, "off_by": 0.000055 },
    { "chain": "robinhood", "reported": 20400532.99, "onchain": 20402959.69, "off_by": 0.000119 },
    { "chain": "bsc", "reported": 22824543.17, "onchain": 24956921.01, "off_by": 0.093,
      "via": "balanceOf" }
  ],
  "notes": ["bsc: Bitquery quota reached"]
}
```

**How to read it:**

- `matches` is the evidence. Two independent tokens naming one address → `confirmed`.
- `off_by` is the drift between fomo's snapshot and the chain now. ~0.01% is a dead-on
  match; the 9.3% BSC entry is a position still being traded, and it corroborates rather
  than proves.
- `method: "blockscout/none"` says Blockscout answered and one chain had no free source.
- `candidates_considered: 1` means nothing else on-chain was even close.

The full response also carries `trader.fomo_reported_wallets` — the addresses fomo
publishes — labelled as provisioned wallets that hold none of these positions. Useful for
showing the difference:

```bash
curl -s localhost:8787/v1/traders/unipcs/wallets \
  | jq '{fomo: .trader.fomo_reported_wallets.evm, real: .resolved_wallets.evm.address}'
```

Solana comes back in the same shape under `.resolved_wallets.solana`:

```bash
curl -s localhost:8787/v1/traders/Morris/wallets | jq '.resolved_wallets.solana.address'
```

---

### `GET /v1/traders/:handle/transactions` — ENDPOINT 2: their trades

**What it does:** resolves the wallets exactly as endpoint 1, then pulls transactions for
those addresses from every chain in parallel and returns them merged, newest first.

```bash
curl -s 'localhost:8787/v1/traders/unipcs/transactions?limit=2' | jq
```

Top-level shape:

```jsonc
{
  "trader": { "handle": "unipcs", "name": "Unipcs", "rank": 44 },
  "scanned_wallets": { "evm": {…}, "solana": {…} },   // which addresses were used
  "chains": [                                         // per-chain status — read this
    { "chain": "base",      "count": 0, "error": "Bitquery quota reached" },
    { "chain": "bsc",       "count": 0, "error": "Bitquery quota reached" },
    { "chain": "ethereum",  "count": 2, "error": null },
    { "chain": "robinhood", "count": 2, "error": null }
  ],
  "count": 4,
  "transfers": [ … ],
  "notes": ["bsc: Bitquery quota reached"],
  "resolve_ms": 29025,
  "fetch_ms": 972,
  "pulled_at": "2026-08-31T…"
}
```

A single transfer:

```jsonc
{
  "chain": "robinhood",
  "tx_hash": "0x19a5375b…a98f",
  "time": 1788181314,
  "time_iso": "2026-08-31T13:01:54.000Z",
  "token": "SIRIUS",
  "contract": "0x0aE6130480841C570E835a4213D8c9a6524A913c",
  "amount": 299577.17512471427,
  "side": "in",
  "from": "0x5A705DE8…89C7",
  "to": "0x0a6EBEd0…119E",
  "explorer_url": "https://robinhoodchain.blockscout.com/tx/0x19a5375b…a98f"
}
```

Solana rows additionally carry `type` and `source` (e.g. `SWAP` / `PUMP_AMM`).

Note `resolve_ms` dwarfs `fetch_ms` — finding the wallet is the slow part, pulling its
transactions is not.

#### Filtering by chain

Restricts which chains are queried, so it is also the way to make the call faster and
cheaper.

```bash
# one chain
curl -s 'localhost:8787/v1/traders/Morris/transactions?chain=solana&limit=20' | jq '.chains'
# [ { "chain": "solana", "count": 20, "error": null } ]

# several
curl -s 'localhost:8787/v1/traders/unipcs/transactions?chain=robinhood,ethereum' | jq '.chains'
```

Valid values: `robinhood`, `ethereum`, `bsc`, `base`, `solana`.

#### Filtering by direction

```bash
curl -s 'localhost:8787/v1/traders/Morris/transactions?chain=solana&limit=50&side=in'  | jq '.count'   # 16
curl -s 'localhost:8787/v1/traders/Morris/transactions?chain=solana&limit=50&side=out' | jq '.count'   # 34
```

`side` is computed against the scanned wallet: `in` means it received.

#### Showing the resolution evidence

`include_evidence=true` adds the `matches` array to `scanned_wallets`, so one call gives
both the proof of *which* wallet and the transactions from it.

```bash
curl -s 'localhost:8787/v1/traders/unipcs/transactions?include_evidence=true' \
  | jq '.scanned_wallets'
```

#### `limit`

Per chain, not overall — default 100, max 300. Requesting 100 across five chains can
return up to 500 transfers.

#### When a wallet is deliberately not scanned

Only `confirmed` and `high-candidate` addresses are scanned. A weaker match would
attribute someone else's transactions to this trader, which is worse than returning
nothing, so the endpoint declines and says why:

```bash
curl -s 'localhost:8787/v1/traders/Rvcoobass/transactions?limit=5' | jq '.scanned_wallets.evm, .notes'
```

```
evm   : "unresolved"   skipped: true
count : 0
notes : ["bsc: Bitquery quota reached", "EVM not scanned — resolution was 'unresolved'"]
```

`count: 0` here does **not** mean the trader has no transactions — it means we could not
establish which wallet is theirs. Always read `notes` and `skipped`.

---

### Unknown handles

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/v1/traders/nosuchtrader/wallets
# 404
curl -s localhost:8787/v1/traders/nosuchtrader/wallets | jq
# { "detail": "no trader 'nosuchtrader' in the directory" }
```

A 404 means the handle is not in the directory file. A trader who *is* present but cannot
be resolved returns **200** with `address: null` and a confidence explaining why — those
are different outcomes on purpose.

---

### With authentication enabled (optional — off by default)

You do not need this to run or test the API; every route is open unless you opt in. If you
set `GENIE_API_KEY` in `.env`, every route except `/v1/health` then requires the header:

```bash
curl -s -H "X-API-Key: your-key" localhost:8787/v1/traders/unipcs/wallets | jq '.resolved_wallets.evm.address'

curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/v1/traders   # 401 without the header
```

Leave `GENIE_API_KEY` unset — the current default — for open access. See
`PROD-STEPS.md` → Future hardening for when to turn it on.

---

## Refreshing

The leaderboard reshuffles constantly, so re-run **Step 2** on a cadence — daily, or
before a demo. Each run needs a fresh `FOMO_TOKEN`.

You do **not** need to restart the API. It re-reads the directory whenever the file's
mtime changes, so a rebuild is picked up on the next request.

A cron entry, remembering that the token expires hourly and so cannot be baked in:

```cron
0 6 * * *  cd /path/to/api-ts && FOMO_TOKEN="$(cat ~/.fomo-token)" python3 build_directory.py
```

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Set FOMO_TOKEN … and rerun` | no token, and `raw/leaderboard.json` does not exist yet |
| `401` / `403` from fomo | token expired — they last about an hour, grab a new one |
| `431 Request Header Fields Too Large` | cookie auth instead of Bearer; the script already uses Bearer |
| `Leaderboard fetch failed` | expired token, or no network |
| Script succeeded but the API shows old data | the filename mismatch in **Step 3** |
| `traders: 0` at `/v1/health` | `WALLETS_FILE` points at a missing or malformed file |
| `ModuleNotFoundError: requests` | `pip install requests` |

---

## What the script does and does not do

**Does:** one HTTP call to the leaderboard, parses `responseObject.leaderboard`, and keeps
handle, display name, both fomo-published addresses, PnL, volume, trade count, followers,
and `topHoldings`. All 150 traders come from that single request.

**Does not:** find real trading wallets. fomo's published `evmAddress` and `address` are
provisioned wallets that hold none of the trader's positions — the API derives the real
ones live by matching reported position sizes against on-chain holders. See `README.md`.

**Overwrites.** Each run replaces `data/wallets.json` wholesale. If a previous run of the
separate resolver scripts had written resolution fields into that file, they are wiped.
That does not affect this API, which ignores those fields and resolves live anyway.
