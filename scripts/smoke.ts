// Smoke test: verifies the deployed service is up, the directory is populated, and the core
// routes answer with the shape consumers read.
//
//   deno task smoke [base_url] [handle]          API_VERSION=v2 for the Cloudflare Worker
//
// Defaults to the live Supabase deployment. Exit 1 when any check fails.

const V = Deno.env.get("API_VERSION") ?? "v1"; // the contract: v1 on Supabase, v2 on the Worker
const BASE = Deno.args[0] ?? "https://gxnonqlmujmtgczvhvzp.supabase.co/functions/v1/api";
const HANDLE = Deno.args[1] ?? "unipcs";

const at = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
// jq truthiness: only null and false are falsy.
const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false;
// jq `length` of null is 0.
const isEmpty = (value: unknown): boolean => value == null || (Array.isArray(value) && value.length === 0);

const status = async (path: string): Promise<number> =>
  (await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) })).status;

// curl -sf: any 4xx/5xx is a failure.
const get = async (path: string): Promise<unknown> => {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(60_000) });
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
};

const checks: ReadonlyArray<readonly [string, () => Promise<boolean>]> = [
  ["health responds", async () => (await status(`/${V}/health`)) < 400],
  ["directory has traders", async () => {
    const traders = at(at(await get(`/${V}/health`), "rows"), "traders");
    return typeof traders === "number" && traders > 0;
  }],
  ["no feed is stale", async () => isEmpty(at(await get(`/${V}/health`), "staleFeeds"))],
  ["trader list responds", async () => {
    const entries = at(await get(`/${V}/traders?limit=1`), "entries");
    return Array.isArray(entries) && entries.length === 1;
  }],
  ["unknown handle is 404", async () => (await status(`/${V}/traders/__nope__/wallets`)) === 404],
  [`wallets resolves ${HANDLE}`, async () => {
    const body = await get(`/${V}/traders/${HANDLE}/wallets`);
    return truthy(at(body, "wallets")) && truthy(at(body, "walletState"));
  }],
  ["transactions responds", async () =>
    Array.isArray(at(await get(`/${V}/traders/${HANDLE}/transactions?limit=5`), "transfers"))],
  ["fields vocabulary served", async () => {
    const body = await get(`/${V}/fields`);
    return typeof body === "object" && body !== null && Object.keys(body).length > 0;
  }],
];

console.log(`genie-fomo API smoke test -> ${BASE}`);
let fail = false;
for (const [name, run] of checks) {
  const ok = await run().catch(() => false);
  console.log(`${name.padEnd(46)}${ok ? "ok" : "FAIL"}`);
  if (!ok) fail = true;
}
console.log();
console.log(fail ? "some checks failed" : "all checks passed");
Deno.exit(fail ? 1 : 0);
