import { sql, n } from "../db.ts";
import { get, post } from "../router.ts";
import { badRequest, notFound } from "../errors.ts";
import { isoParam, parseIso } from "../shared/params.ts";
import { resolveTrader } from "../shared/traders.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";

/**
 * Net token flow per trader since a moment, from `transactions` (Solana only: the webhook is
 * the one real-time feed). Workflow gap 4, the W-F "hourly holdings diff across the cohort"
 * substrate: poll it hourly with `since` = the previous poll. A category / launchpad taxonomy
 * for tokens is NOT in scope here; the app groups rows by `tokenKey` itself.
 *
 * Amounts are the feed's, signed by direction and summed in SQL. `tokenAddress` is null when
 * the mint is not yet in the directory: the feed stores a lowercased key, and Solana base58
 * is case-sensitive, so the key is served as `tokenKey` rather than passed off as an address.
 */
const SOLANA = 1399811149;

/** CROSS JOIN pins wallets first: given a LIST of handles the planner otherwise starts from every Solana transfer. */
export const flowRows = (handles: string[], since: string) => sql`
  select w.handle, c.name as chain, tk.address as token_address, t.token_key,
         sum(case when t.direction = 'in' then t.amount end) as in_amount,
         sum(case when t.direction = 'out' then t.amount end) as out_amount,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as net,
         count(*) as transfers,
         min(t.block_time) as first_at, max(t.block_time) as last_at
  from wallets w
  cross join transactions t on t.address_key = w.sol_address_key
  join chains c on c.network_id = t.network_id
  left join tokens tk on tk.network_id = t.network_id and tk.token_key = t.token_key
  where w.handle in (${handles})
    and t.network_id = ${SOLANA}
    and t.direction in ('in', 'out')
    and t.amount is not null
    and t.block_time >= ${since}
  group by w.handle, c.name, tk.address, t.token_key
  order by w.handle,
           abs(sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end)) desc`;

const iso = (v: unknown) => (v ? new Date(String(v)).toISOString() : null);

const flowRow = (r: Record<string, unknown>) => ({
  chain: r.chain,
  tokenAddress: (r.token_address as string | null) ?? null,
  tokenKey: r.token_key,
  in: n(r.in_amount) ?? 0,
  out: n(r.out_amount) ?? 0,
  net: n(r.net) ?? 0,
  transfers: Number(r.transfers),
  firstAt: iso(r.first_at),
  lastAt: iso(r.last_at),
});

const envelope = (since: string) => ({
  since,
  basis: "transactions",
  chains: ["solana"],
  note: "signed transfers from the Solana webhook feed since `since`, per token; EVM has no " +
        "real-time feed and is absent. No category taxonomy: group by tokenKey yourself.",
});

get("/v1/traders/:handle/flow", async ({ handle }, url) => {
  const since = isoParam(url, "since");
  if (since === null) throw badRequest("'since' is required: an ISO-8601 timestamp", { parameter: "since" });
  const [t] = await sql`
    select handle, display_handle from traders where handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);
  const rows = await flowRows([t.handle as string], since);
  return {
    handle: t.display_handle,
    ...envelope(since),
    count: rows.length,
    rows: rows.map(flowRow),
  };
});

post("/v1/traders/flow", async (_p, _url, body) => {
  const { requested, handles, asked, capped } = await batchIds(body);
  const since = parseIso((body as { since?: unknown })?.since, "since");
  if (since === null) throw badRequest("body must carry 'since': an ISO-8601 timestamp", { parameter: "since" });

  const known = await sql`select handle, display_handle from traders where handle in (${handles})`;
  const display = new Map<string, string>(
    known.map((r: Record<string, unknown>) => [String(r.handle), String(r.display_handle)]));
  const by = new Map<string, Record<string, unknown>[]>();
  for (const r of await flowRows(handles, since)) {
    const h = String(r.handle);
    if (!by.has(h)) by.set(h, []);
    by.get(h)!.push(r);
  }
  return {
    ...batchEnvelope(asked, capped, null),
    ...envelope(since),
    /* One row per requested id, successes and failures alike (mirrors POST /traders/positions). */
    traders: requested.map((req, i) => {
      const h = handles[i];
      if (!display.has(h)) {
        return { ok: false as const, requested: req, handle: null,
                 error: { code: "not_found", detail: `no trader '${req}' in the directory` } };
      }
      const rows = (by.get(h) ?? []).map(flowRow);
      return { ok: true as const, requested: req, handle: display.get(h), count: rows.length, rows };
    }),
  };
});
