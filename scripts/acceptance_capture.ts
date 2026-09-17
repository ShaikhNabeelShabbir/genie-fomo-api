// Acceptance capture: fetch every route the acceptance suite covers, for a fixed set of
// traders, and write one normalised JSON file per call so two deployments can be diffed.
//
//   deno task capture <base_url> <out_dir> [handle ...]
//
//   deno task capture https://<ref>.supabase.co/functions/v1/api captures/before
//   API_VERSION=v2 deno task capture https://genie-copy-trading-api.<subdomain>.workers.dev captures/after
//   diff -r captures/before captures/after
//
// Run it TWICE against the same deployment first and diff those. That diff must be empty; if
// it is not, the harness is stripping too little and cannot be trusted to judge a port.
//
// What is stripped, and why: the fields the API documents as live (`asOf`, `liveRead`,
// timestamp-valued `from`/`to`, every `*ageSeconds`/`*AgeSeconds`, `requestedFrom`,
// `pipelineLastSuccessAt`, `requestId`) change on every call and say nothing about whether the
// port is correct. Everything else, including every other `*At`, is kept: those are stored
// values and two reads minutes apart against one database must agree. The rules live in
// scripts/lib/normalise.ts. `/v1/health` is captured as its key set only.
//
// Set GENIE_API_KEY in the environment if the deployment requires X-API-Key.

import { isJsonObject, type Json, normalise, render, renderKeys } from "./lib/normalise.ts";

const USAGE = `usage: deno task capture <base_url> <out_dir> [handle ...]

  API_VERSION=v1|v2 picks the contract (default v1); v2 links are folded back to v1.
  GENIE_API_KEY is sent as x-api-key when set. Run twice against one deployment first
  and diff; that diff must be empty.`;

if (Deno.args.length < 2) {
  console.log(USAGE);
  Deno.exit(2);
}

const BASE = Deno.args[0].replace(/\/$/, "");
// The contract to capture: v1 (Supabase) or v2 (the Cloudflare Worker, same routes).
const V = Deno.env.get("API_VERSION") ?? "v1";
const OUT = Deno.args[1];
// The five traders CLOUDFLARE_MIGRATION.md §12 names: a spread of sizes and chains.
const HANDLES: readonly string[] = Deno.args.length > 2
  ? Deno.args.slice(2)
  : ["unipcs", "ogle", "poopinyourhands", "0xavast", "notanicecat69"];

const apiKey = Deno.env.get("GENIE_API_KEY");
const AUTH: Record<string, string> = apiKey ? { "x-api-key": apiKey } : {};

await Deno.mkdir(OUT, { recursive: true });

let fail = false;

const request = (method: string, path: string, body?: string): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? AUTH : { ...AUTH, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(60_000),
  });

// jq on an empty body writes nothing; anything else that is not JSON is kept verbatim.
const normalisedText = (raw: string): string | null => {
  if (raw.trim() === "") return "";
  try {
    return render(normalise(JSON.parse(raw) as Json));
  } catch {
    return null;
  }
};

const capture = async (name: string, method: string, path: string, body?: string): Promise<void> => {
  const file = `${OUT}/${name}.json`;
  let status: number;
  let raw: string;
  try {
    const res = await request(method, path, body);
    status = res.status;
    raw = await res.text();
  } catch {
    console.error(`FAIL  ${name}  (curl error)`);
    fail = true;
    return;
  }
  const text = normalisedText(raw);
  if (text === null) console.error(`WARN  ${name}  HTTP ${status}  (non-JSON body)`);
  await Deno.writeTextFile(file, text ?? raw);
  await Deno.writeTextFile(`${OUT}/${name}.status`, `${status}\n`);
  console.log(`${name.padEnd(44)} HTTP ${status}`);
};

console.log(`capturing ${BASE} -> ${OUT}`);

// ---- global routes -------------------------------------------------------------------------
await capture("chains", "GET", `/${V}/chains`);
await capture("fields", "GET", `/${V}/fields`);
await capture("tokens", "GET", `/${V}/tokens?limit=25`);
await capture("tokens_momentum", "GET", `/${V}/tokens/momentum`);
await capture("traders", "GET", `/${V}/traders?limit=25`);
await capture("traders_included", "GET", `/${V}/traders?limit=10&include=pnl,scorecard,wallets,trust`);
await capture("traders_search", "GET", `/${V}/traders?q=${HANDLES[0]}`);

// health: shape only
try {
  const health = JSON.parse(await (await request("GET", `/${V}/health`)).text()) as Json;
  if (!isJsonObject(health)) throw new Error("health body is not an object");
  await Deno.writeTextFile(`${OUT}/health_keys.json`, renderKeys(health));
  console.log(`${"health_keys".padEnd(44)} ok`);
} catch {
  console.error("FAIL  health_keys");
  fail = true;
}

// ---- per-trader routes ---------------------------------------------------------------------
for (const h of HANDLES) {
  const p = `/${V}/traders/${h}`;
  await capture(`${h}.profile`, "GET", p);
  await capture(`${h}.wallets`, "GET", `${p}/wallets`);
  await capture(`${h}.scorecard`, "GET", `${p}/scorecard`);
  await capture(`${h}.pnl`, "GET", `${p}/pnl`);
  await capture(`${h}.portfolio`, "GET", `${p}/portfolio`);
  await capture(`${h}.positions`, "GET", `${p}/positions?limit=25`);
  await capture(`${h}.trades`, "GET", `${p}/trades?limit=25`);
  await capture(`${h}.transactions`, "GET", `${p}/transactions?limit=25`);
  await capture(`${h}.transactions_money`, "GET", `${p}/transactions?limit=25&money=true`);
  await capture(`${h}.trust`, "GET", `${p}/trust`);
  await capture(`${h}.aum_1m`, "GET", `${p}/aum?window=1m&live=false`);
  await capture(`${h}.aum_1w_solana`, "GET", `${p}/aum?window=1w&chain=solana&live=false`);
}

// ---- batch routes --------------------------------------------------------------------------
await capture("batch_positions", "POST", `/${V}/traders/positions`, JSON.stringify({ ids: HANDLES }));
await capture("batch_aum_1m", "POST", `/${V}/traders/aum`, JSON.stringify({ ids: HANDLES, window: "1m" }));

// ---- the refusals the suite checks ---------------------------------------------------------
await capture("unknown_handle", "GET", `/${V}/traders/__no_such_trader__/wallets`);
await capture("unknown_route", "GET", `/${V}/nope`);

// A colliding wallet submission must answer 409 address_in_use. Only exercised when the
// secret is available; the route is the service's one write and is refused without it.
const secret = Deno.env.get("WALLET_SUBMIT_SECRET");
const second = HANDLES[1];
if (secret && second !== undefined) {
  const firstEvm = await Deno.readTextFile(`${OUT}/${HANDLES[0]}.wallets.json`)
    .then((text) => {
      const wallets = JSON.parse(text) as Json;
      if (!isJsonObject(wallets)) return null;
      const resolved = wallets.resolved_wallets;
      return wallets.evmAddress ?? (isJsonObject(resolved) ? resolved.evm : null) ?? null;
    })
    .catch(() => null);
  if (typeof firstEvm === "string" && firstEvm !== "") {
    await capture(
      "wallet_collision",
      "POST",
      `/${V}/traders/${second}/wallets`,
      JSON.stringify({ secret, evmAddress: firstEvm }),
    );
  }
}

console.log();
if (fail) {
  console.error("captured with failures — see above");
} else {
  const count = [...Deno.readDirSync(OUT)].filter((e) => e.name.endsWith(".json")).length;
  console.log(`captured ${count} files into ${OUT}`);
}
Deno.exit(fail ? 1 : 0);
