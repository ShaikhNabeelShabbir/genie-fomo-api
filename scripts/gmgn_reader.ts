// The GMGN reader that runs OUTSIDE the Worker.
//
// GMGN answers HTTP 429 to the Worker before its key is checked: the limit is per IP, and a Worker
// shares its outgoing IPs with other Cloudflare customers (measured 19 Sep 2026; from a clean
// address a keyless request gets 401, i.e. it reaches GMGN's auth). So this runs wherever there is
// an address of our own — a container, a small VM, a CI runner, a laptop — asks the Worker what is
// due, reads it with the SAME loop the Worker's job uses, and posts the results back. The Worker
// does every database write.
//
//   GMGN_RELAY_SECRET=… GMGN_API_KEY=… deno task gmgn
//   optional: WORKER_URL, GMGN_LIMIT (coins asked for, default 300), GMGN_BUDGET_MS (default 25 min)

import { type CoinSink, type InfoTarget, type RelayResult, RELAY_BATCH_MAX, missesAfterFirstStore, readCoins } from "../worker/src/jobs/tokens-core.ts";

const need = (name: string): string => {
  const v = (Deno.env.get(name) ?? "").trim();
  if (!v) { console.error(`${name} is not set`); Deno.exit(2); }
  return v;
};
const WORKER = (Deno.env.get("WORKER_URL") ?? "https://genie-copy-trading-api.agent-73b.workers.dev").replace(/\/$/, "");
const SECRET = need("GMGN_RELAY_SECRET"), KEY = need("GMGN_API_KEY");
const LIMIT = Number(Deno.env.get("GMGN_LIMIT") ?? 300);
const BUDGET_MS = Number(Deno.env.get("GMGN_BUDGET_MS") ?? 25 * 60_000);
// The secret travels in a header: only to https (or a local Worker), and never along a redirect.
if (!/^https:\/\//.test(WORKER) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(WORKER)) { console.error("WORKER_URL must be https"); Deno.exit(2); }
// A knob that is not a number must not mean "no limit".
if (!(BUDGET_MS > 0) || !(Number.isInteger(LIMIT) && LIMIT > 0)) { console.error("GMGN_LIMIT and GMGN_BUDGET_MS must be positive numbers"); Deno.exit(2); }
// Cloudflare's bot protection in front of the Worker refuses a default library User-Agent (403, error 1010).
const HEADERS = { "x-job-secret": SECRET, "user-agent": "genie-gmgn-reader/1.0", "content-type": "application/json" };

/** One call to the Worker's relay; anything but 2xx stops the run, so nothing is dropped quietly. */
async function relay<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${WORKER}${path}`, { ...init, headers: HEADERS, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path} answered HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json() as T;
}

const started = Date.now();
const { due, targets } = await relay<{ due: number; targets: InfoTarget[] }>(`/jobs/gmgn_queue?limit=${LIMIT}`);
console.log(`gmgn reader: ${due} coins due, reading ${targets.length}`);

const pending: RelayResult[] = [];
const totals = { stored: 0, missed: 0, flipped: 0, unknown: 0, failed: 0, rejected: 0 };
/** The first failed post. readCoins treats a throwing sink as one unstorable coin and carries on, so the run is ended through `outOfTime`. */
let relayDown: unknown = null;
async function flush(): Promise<void> {
  while (pending.length && relayDown === null) {
    const batch = pending.splice(0, RELAY_BATCH_MAX);
    try {
      const a = await relay<{ stored: number; missed: number; flipped: number; unknown: number; failed: number; rejected: unknown[] }>(
        "/jobs/gmgn_results", { method: "POST", body: JSON.stringify({ results: batch }) });
      totals.stored += a.stored; totals.missed += a.missed; totals.flipped += a.flipped; totals.unknown += a.unknown; totals.failed += a.failed; totals.rejected += a.rejected.length;
    } catch (e) {
      relayDown = e; // those coins stay due and are read again next run; nothing is retried here, so fetched_at never lies
    }
  }
}
const posting: CoinSink = {
  async store(t, info, security) {
    pending.push({ network_id: t.network_id, token_key: t.token_key, chain: t.chain, info, security });
    if (pending.length >= 25) await flush();
    return false; // the Worker says which stores raised a flag; the total is in `totals.flipped`
  },
  async miss(t, nothing) {
    pending.push({ network_id: t.network_id, token_key: t.token_key, chain: t.chain, nothing });
    if (pending.length >= 25) await flush();
  },
};
/* "GMGN has nothing" is believed only once this run has stored a real document: see missesAfterFirstStore. */
const careful = missesAfterFirstStore(posting);

const read = await readCoins(targets, KEY, () => relayDown !== null || Date.now() - started > BUDGET_MS, careful.sink);
await flush();
const withheld = careful.held();
if (withheld.length) console.error(`gmgn reader: GMGN gave no document this run; ${withheld.length} "nothing" answers NOT recorded (first: ${withheld[0].detail})`);
console.log(JSON.stringify({ due, read, written: totals, withheld: withheld.length, elapsedMs: Date.now() - started }));
if (relayDown !== null) { console.error(`gmgn reader: the Worker refused a batch, run ended: ${relayDown instanceof Error ? relayDown.message : String(relayDown)}`); Deno.exit(1); }
// A run that stored nothing is a failure, whatever it parked.
if (read.attempted > 0 && totals.stored === 0) Deno.exit(1);
