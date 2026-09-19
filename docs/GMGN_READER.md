# The GMGN reader: why it runs outside the Worker, and how to run it

## Why

GMGN's token API allows one request a second **per IP**. A Cloudflare Worker shares its outgoing
IPs with other customers, so that second is spent before we ask:

| Asked from | With | GMGN answered (19 Sep 2026) |
|---|---|---|
| the Worker (14:05 and 16:05 UTC runs) | a valid key | **429** on the first read, every read |
| a clean address | no key | **401** `AUTH_INVALID` — the request reaches GMGN's auth |

The limiter sits in front of the key check, so no key fixes it. Nothing has been read from GMGN
since the move to Cloudflare (`/health` → `feeds.tokenInfo`); the last reads were made by the old
loader, which ran from a machine of its own.

## How it works

One read loop, `readCoins` in `worker/src/jobs/tokens-core.ts`, behind a sink:

- in the Worker's `tokens` job the sink writes D1 directly (it still runs, and doubles as the canary
  that will tell us if the Worker's address ever becomes acceptable);
- in `scripts/gmgn_reader.ts` the sink posts batches back to the Worker.

```
reader ── GET  /jobs/gmgn_queue?limit=300 ──▶ Worker   what is due, most-held and longest-waiting interleaved
reader ── GMGN, 1 request a second ─────────▶ GMGN     info + security per coin; five refusals in a row end the run
reader ── POST /jobs/gmgn_results ──────────▶ Worker   checked field by field; every D1 write happens here
```

Both routes are behind **`GMGN_RELAY_SECRET`** (`x-job-secret`), which opens nothing else: `JOB_SECRET`
runs jobs and never leaves the owner, so a reader's box that is lost cannot run them. The Worker refuses a
result for a coin it holds no `tokens` row for (or whose chain is not the one it records), takes no body
over 2 MB, and believes "GMGN has nothing for this coin" only in a run that also stored a real document.

## Run it

```bash
GMGN_RELAY_SECRET=… GMGN_API_KEY=… deno task gmgn
# optional: WORKER_URL, GMGN_LIMIT (default 300), GMGN_BUDGET_MS (default 25 minutes)
```

It prints one JSON summary and exits 1 when work was attempted and none of it landed (GMGN refused
this address too). Capacity: two requests a coin at GMGN's pace is about 680 coins in 25 minutes;
every 2 hours that is ~8,000 coins a day against ~32,000 held, so most-held coins stay under a day
old and the one-holder tail turns over in a few days.

**Before the first run the owner sets `GMGN_RELAY_SECRET`** (until then `/jobs/gmgn_*` answers 503):
`cd worker && printf '%s' '<value>' | npx wrangler secret put GMGN_RELAY_SECRET`. Do not reuse `JOB_SECRET`.

## Where to host it

Anywhere with an address that is not a shared Cloudflare Worker egress. In order of effort:

1. **A laptop, once**, to prove the path end to end.
2. **A scheduled CI runner** (free while the repository is public).
3. **A small VM** with a cron line (cheapest once the repository is private).
4. **Cloudflare Containers** — the closest thing Cloudflare has to a VM. **Unproven for this**: a
   container's traffic also leaves from Cloudflare's ranges, and GMGN's limiter may treat it exactly
   like the Worker. Probe before building: deploy a throwaway container that makes ONE keyless
   request to `https://openapi.gmgn.ai/v1/token/info?chain=sol&address=<any mint>` and logs the
   status. **401 means the address is clean — build the reader there. 429 means Cloudflare cannot
   host it.** Needs Docker running locally (wrangler builds the image) and an API token with the
   Containers permission.
