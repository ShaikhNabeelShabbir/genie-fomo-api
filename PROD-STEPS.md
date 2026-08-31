# PROD-STEPS — deploying and using the API in production

Covers deploying to Render, Railway, Fly or any Docker host, and calling it once it's up.

`STEPS.md` covers local setup and what each route does. This file is about running it for
other people.

---

## Read this first

Three properties of this service shape every production decision:

**1. It is not free to run.** Every `/wallets` and `/transactions` call spends real quota —
Helius bills 100 credits per transaction pull, Bitquery meters points, Blockscout starts
returning 403 challenges under load. There is **no cache**. An unprotected public endpoint
is a way to lose a month of quota in an afternoon.

**2. Resolution is slow.** 1–30 seconds, because it queries on-chain holder lists per
position. Warm with Bitquery it's typically ~1–2s; a Solana position outside a mint's top
20 falls through to a full DAS scan and can take 20s+. Plan timeouts accordingly.

**3. The directory file goes stale and cannot refresh itself.** `build_directory.py` needs
a `FOMO_TOKEN` — a personal browser cookie that expires hourly — so it cannot run on the
server. See [Keeping the directory fresh](#keeping-the-directory-fresh).

---

## Pre-deploy checklist

| | |
| --- | --- |
| `CORS_ORIGINS` set | otherwise any website can drive requests on your quota |
| `.env` **not** committed | it is gitignored; set real values in the platform dashboard |
| Health check path | `/v1/health` |
| Directory file present | baked into the image at `data/`, or mounted |
| Node 20+ | declared in `engines` |

**There is no authentication.** Every route is open. That is the current intended setup —
see [Future hardening](#future-hardening) before putting this anywhere untrusted.

```bash
npm run typecheck && npm run build && npm start   # verify locally first
./scripts/smoke.sh http://localhost:8787
```

---

## Render

Web Service → connect the repo → root directory `api-ts` if it lives in a monorepo.

| Setting | Value |
| --- | --- |
| Environment | Node |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/v1/health` |

Add environment variables in the dashboard: `CORS_ORIGINS`, `HELIUS_SOLANA_KEY`,
`BITQUERY_KEY`, `ETHERSCAN_KEY`.

Do **not** set `PORT` — Render injects it, and the service reads `process.env.PORT`.

> Free instances sleep after inactivity and cold-start on the next request. Combined with
> a 1–30s resolution that makes the first call after idle feel broken. Use a paid instance,
> or keep it warm by pinging `/v1/health`.

## Railway

New Project → deploy from repo → set the root directory to `api-ts` if needed.

| Setting | Value |
| --- | --- |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Healthcheck Path | `/v1/health` |

Railway injects `PORT` too. Add the same variables under **Variables**.

## Fly.io

```bash
cd api-ts
fly launch --no-deploy          # detects the Dockerfile
fly secrets set HELIUS_SOLANA_KEY=… BITQUERY_KEY=… ETHERSCAN_KEY=… \
               CORS_ORIGINS=https://app.example.com
fly deploy
```

In `fly.toml` set `internal_port = 8787` to match the Dockerfile's `EXPOSE`, and point the
HTTP check at `/v1/health`.

## Any Docker host

```bash
docker build -t genie-fomo-api .
docker run -d -p 8787:8787 \
  -e HELIUS_SOLANA_KEY=… -e BITQUERY_KEY=… -e ETHERSCAN_KEY=… \
  -e CORS_ORIGINS=https://app.example.com \
  genie-fomo-api
```

The image is multi-stage and ships `data/` inside it, so it runs with no volumes. Mount a
volume over `/app/data` if you'd rather update the directory without rebuilding.

---

## Environment variables in production

| Variable | Production guidance |
| --- | --- |
| `CORS_ORIGINS` | **Set it.** Comma-separated origins; blank means any origin |
| `GENIE_API_KEY` | not needed today — leave unset for open access ([future hardening](#future-hardening)) |
| `HELIUS_SOLANA_KEY` | required for Solana addresses and transactions |
| `BITQUERY_KEY` | required for BSC/Base, and for resolving small positions |
| `ETHERSCAN_KEY` | required for Ethereum transactions |
| `WALLETS_FILE` | only if the directory is not at `./data/wallet.full.data.json` |
| `PORT` | leave unset — the platform injects it |

Startup logs confirm the security-relevant settings so you can spot a misconfigured deploy:

```
genie-fomo API (typescript) on port 8787
  directory: 150 traders
  auth: none (open access)          ← expected today
  cors: https://app.example.com     ← "any origin" means unrestricted
```

---

## Verifying a deployment

```bash
BASE=https://your-service.onrender.com

# 1. providers and directory
curl -s $BASE/v1/health | jq '{traders: .directory.traders, providers: [.providers|to_entries[]|{(.key): .value.configured}]}'

# 2. the directory responds
curl -s "$BASE/v1/traders?limit=3" | jq '.total'

# 3. full smoke test against prod
./scripts/smoke.sh $BASE
```

Then a real resolution:

```bash
curl -s $BASE/v1/traders/twaptops/wallets \
  | jq '{evm: .resolved_wallets.evm.address, sol: .resolved_wallets.solana.address, ms: .elapsed_ms}'
```

---

## Calling it from an application

```bash
curl -s "$BASE/v1/traders/twaptops/transactions?chain=solana&limit=50"
```

```ts
const res = await fetch(
  `${BASE}/v1/traders/${handle}/transactions?chain=solana&limit=50`,
);
const data = await res.json();

// A chain with count 0 and error null genuinely has no activity.
// A chain with count 0 and an error could not be reached — do not show these the same way.
for (const c of data.chains) {
  if (c.error) console.warn(`${c.chain} unavailable: ${c.error}`);
}
```

Since there is no API key today, a browser can call this directly provided its origin is
in `CORS_ORIGINS`. Prefer proxying through your own backend anyway: it gives you a place
to add per-user limits and caching, and it means enabling auth later is a one-line change
on the server you control rather than a redeploy of every client.

### Client rules that matter in production

- **Always read `chains[]`.** `count: 0, error: null` (no activity) and `count: 0,
  error: "…"` (couldn't look) are different answers.
- **Always read `confidence`.** `confirmed` and `high-candidate` are safe to display;
  anything else means we could not establish the wallet, and `/transactions` returns
  `skipped: true` rather than guessing.
- **Expect slow responses.** Set client timeouts to at least 45s, or use `?chain=` to
  narrow the work.
- **`limit` is per chain,** so `limit=100` across five chains can return 500 rows.

---

## Keeping the directory fresh

This is the main operational chore. `build_directory.py` needs a `FOMO_TOKEN` — a personal
browser cookie that expires in about an hour — so it **cannot run on the server**. The
realistic loop is: build locally, ship the file.

```bash
# on your machine
cd api-ts
export FOMO_TOKEN="…"              # fresh from fomo.family cookies
python3 build_directory.py
cp data/wallets.json data/wallet.full.data.json
git commit -am "refresh directory" && git push      # triggers a redeploy
```

Alternatives if redeploying to refresh data is too coarse:

- **Mounted volume** (Fly volume, Railway volume, Render disk): mount over `/app/data` and
  upload the new file. The service re-reads it when the mtime changes — **no restart
  needed**.
- **Object storage**: upload to S3/R2 and have the container fetch it at boot into
  `WALLETS_FILE`. Adds a startup dependency, but decouples data from deploys.

Staleness is not catastrophic — a stale directory means the trader *list* is old. Wallets
and transactions are always resolved live against the chain.

---

## Operating it

**Add a cache before real traffic.** The single highest-value change. Resolutions keyed on
`(handle)` and transactions on `(wallet, chain)`, 5–15 minutes, would remove nearly all
repeat provider calls. Right now every request pays full price.

**Rate limit at the edge.** There is none in the service. `express-rate-limit`, or your
platform's/CDN's limiter, ideally per API key.

**Watch the quotas, not just the uptime.** The service stays "healthy" while returning
degraded results — a spent Bitquery quota surfaces as `"Bitquery quota reached"` in
`chains[].error`, not as a 500. Alert on that string, and check `/v1/health` for provider
configuration.

**Scaling.** Stateless, so horizontal scaling works — but every instance shares the same
provider quotas, so more instances mean faster quota burn, not more throughput. A shared
cache (Redis) matters more than instance count.

**Graceful shutdown** is handled: `SIGTERM`/`SIGINT` stop new connections and let in-flight
requests finish, with a 10s cap. Deploys will not cut off a 20s resolution mid-flight.

---

## Future hardening

Not needed today. Do these before the service is reachable by anyone you don't trust, or
before it sits behind a public product.

### API key authentication

Already implemented and switched off. Set one variable and it turns on — no code change,
no redeploy of the service beyond picking up the env var:

```bash
GENIE_API_KEY=some-long-random-string
```

From that moment every route **except `/v1/health`** requires a matching header:

```bash
curl -s -H "X-API-Key: some-long-random-string" $BASE/v1/traders/twaptops/wallets
```

Requests without it get `401 {"detail":"invalid or missing X-API-Key"}`. `/v1/health` stays
open deliberately so platform health probes keep working.

Confirm it took effect in the startup log:

```
auth: X-API-Key required     ← on
auth: none (open access)     ← off
```

Two things to plan for when you enable it: `scripts/smoke.sh` does not send the header, so
its authenticated checks will fail until you add one; and any client already calling the
API needs the header at the same moment, which is the argument for proxying through your
own backend rather than calling from browsers directly.

It is a single shared secret, so it authenticates *an application*, not a user. For
per-user attribution you want a gateway in front, or a real key table.

### The rest, roughly in priority order

**A cache.** The highest-value change by far, and more urgent than auth. Resolutions keyed
on `(handle)`, transactions on `(wallet, chain)`, 5–15 minutes. Today every request pays
full provider cost, which is what actually exhausts a quota.

**Rate limiting.** None in the service. `express-rate-limit`, or your platform's/CDN's
limiter. Pairs with auth: limit per key rather than per IP.

**Request logging.** No access log today. Something structured with handle, chains,
elapsed time and provider errors would make quota burn and slow resolutions visible.

**Quota alerting.** The service returns `200` with degraded results when a provider quota
is spent — alert on `chains[].error` containing `quota`, not just on 5xx.

---

## Production troubleshooting

| Symptom | Cause |
| --- | --- |
| CORS errors in a browser | origin not in `CORS_ORIGINS` |
| `401` on everything | only possible if `GENIE_API_KEY` is set — send a matching `X-API-Key`, or unset it |
| Gateway timeout on first request | free-tier cold start plus a slow resolution — keep it warm |
| `bsc`/`base` always error | `BITQUERY_KEY` missing or out of points — no free substitute exists |
| `Blockscout HTTP 403 (rate limited)` | too many requests; the service retries with backoff — add a cache |
| `traders: 0` at `/v1/health` | `WALLETS_FILE` missing in the image or the mount |
| Everything `unresolved` | check `/v1/health` providers before suspecting the data |
| Suddenly slow | Bitquery quota gone, so resolution fell back to Blockscout paging |

Quick provider check from anywhere:

```bash
curl -s $BASE/v1/health | jq '.providers | to_entries[] | {(.key): .value.configured}'
```
