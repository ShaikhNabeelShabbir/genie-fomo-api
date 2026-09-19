import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";
import { flowRows } from "../supabase/functions/api/routes/flow.ts";
import {
  encodeEventCursor, toEvent, type EventCursor, type EventRow,
} from "../supabase/functions/api/routes/events.ts";

/*
 * EQUIVALENCE for the statements the transactions family rewrote after the 19 Sep 2026 plan audit
 * (/trades fees, /flow, /events): the OLD statement text, verbatim, against the NEW code path, on
 * rows that exercise the edges. HOW rows are fetched changed; WHAT is answered must not.
 */
const SOL = 1399811149;
const SINCE = "2026-09-01T00:00:00.000Z";
const db = await openSchema();

type Param = string | number | null;
type Row = Record<string, unknown>;
const run = (text: string, ...p: Param[]): void => void db.prepare(text).run(...p);
const all = (text: string, ...p: Param[]): Row[] => (db.prepare(text).all(...p) as Row[]).map((r) => ({ ...r }));
const marks = (k: number): string => Array.from({ length: k }, () => "?").join(", ");
const getJson = async (path: string): Promise<Row> => {
  const res = await handle(new Request(`https://test.local${path}`, { headers: { "user-agent": "plans-transactions-test/1.0" } }));
  const text = await res.text();
  assertEquals(res.status, 200, `${path} -> ${text.slice(0, 200)}`);
  return JSON.parse(text) as Row;
};

// ------------------------------------------------------------------ seed
// a: both wallets. b: Solana only. c: wallets and NO rows anywhere. d: EVM only.
for (const [h, evm, sol] of [["a", "0xAa", "SolA"], ["b", null, "SolB"], ["c", "0xCc", "SolC"], ["d", "0xDd", null]] as const) {
  run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h.toUpperCase(), `id-${h}`);
  run("insert into wallets (handle, evm_address, sol_address) values (?,?,?)", h, evm, sol);
}
run("insert into tokens (network_id, address, token_key) values (?,?,?)", SOL, "Mint1Cased", "mint1cased");
run("insert into token_info (network_id, token_key, is_honeypot, can_not_sell) values (?,?,1,0)", SOL, "mint1cased");

let seq = 0;
const transfer = (net: number, hash: string, key: string, at: string | null, dir: string | null, token: string | null, amount: number | null): void =>
  run(`insert into transactions (network_id, tx_hash, address_key, block_time, direction, token_key, amount, source, transfer_key)
       values (?,?,?,?,?,?,?,'test',?)`, net, hash, key, at, dir, token, amount, `k${seq++}`);
transfer(SOL, "s-old", "sola", "2026-08-15T00:00:00.000Z", "in", "mint1cased", 100);   // before `since`
transfer(SOL, "s-edge", "sola", SINCE, "in", "mint1cased", 1);                          // exactly `since`
transfer(SOL, "s-1", "sola", "2026-09-02T00:00:00.000Z", "in", "mint1cased", 4);
transfer(SOL, "s-2", "sola", "2026-09-03T00:00:00.000Z", "out", "mint1cased", 2);       // mint1 net +3
transfer(SOL, "s-3", "sola", "2026-09-02T00:00:00.000Z", "in", "mint2unknown", 3);      // net +3: a TIE, and no directory row
transfer(SOL, "s-4", "sola", "2026-09-04T00:00:00.000Z", "out", "mint3", 7);
transfer(SOL, "s-4", "sola", "2026-09-04T00:00:00.000Z", "in", "mint1cased", 0.5);      // two transfers, ONE tx: a tie on (at, kind, id)
transfer(SOL, "s-null-amount", "sola", "2026-09-04T01:00:00.000Z", "in", "mint3", null);
transfer(SOL, "s-self", "sola", "2026-09-04T02:00:00.000Z", "self", "mint3", 9);
transfer(SOL, "s-null-time", "sola", null, "in", "mint3", 9);
transfer(1, "e-1", "0xaa", "2026-09-02T12:00:00.000Z", "in", "0xtoken", 11);            // a's EVM wallet: a second chain
transfer(SOL, "s-ab", "sola", "2026-09-05T00:00:00.000Z", "out", "mint3", 1.5);        // a pays b: one tx under two traders
transfer(SOL, "s-ab", "solb", "2026-09-05T00:00:00.000Z", "in", "mint3", 1.5);

const swap = (net: number, hash: string, key: string, at: string, token: string, delta: number): void =>
  run(`insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_usd)
       values (?,?,?,?,?,?,?)`, net, hash, key, at, token, delta, -2);
const fee = (net: number, hash: string, native: number, symbol: string): void =>
  run("insert into transaction_fees (network_id, tx_hash, fee_native, fee_native_symbol, source) values (?,?,?,?,'test')", net, hash, native, symbol);
swap(1, "h1", "0xaa", "2026-09-02T00:00:00.000Z", "0xtoken", 10);
swap(1, "h2", "0xaa", "2026-09-03T00:00:00.000Z", "0xtoken", -4);                       // no fee read yet
swap(SOL, "s1", "sola", "2026-09-03T06:00:00.000Z", "mint1cased", 5);
fee(1, "h1", 0.001, "ETH");
fee(SOL, "s1", 0.000005, "SOL");
fee(56, "h1", 9, "BNB");                                                                 // same hash on a chain NOT on the page
fee(SOL, "h1", 8, "SOL");                                                                // same hash on a page chain that is not the row's
for (let i = 0; i < 120; i++) {                                                          // d: a page past 100 binds, the json_each form
  swap(1, `d${i}`, "0xdd", new Date(Date.UTC(2026, 8, 6, 0, i)).toISOString(), "0xtoken", 1);
  if (i % 2 === 0) fee(1, `d${i}`, i / 1000, "ETH");
}

const reading = (h: string, at: string, usd: number | null, refused: string | null, basis: string): void =>
  run("insert into aum_samples (handle, at, total_usd, refused_reason, basis, tier, sampled_at) values (?,?,?,?,?,'verified',?)", h, at, usd, refused, basis, at);
reading("a", "2026-09-02T00:00:00.000Z", 1234.5, null, "sampled");                       // same instant as a transfer and a swap
reading("a", "2026-09-04T00:00:00.000Z", null, "no_prices", "sampled");
reading("b", "2026-09-04T00:00:00.000Z", 10, null, "rebuilt");                           // not a reading
reading("b", "2026-08-20T00:00:00.000Z", 10, null, "sampled");                           // before `since`

// ------------------------------------------------------------------ /flow
const OLD_FLOW = (k: number): string => `
  select w.handle, c.name as chain, tk.address as token_address, t.token_key,
         sum(case when t.direction = 'in' then t.amount end) as in_amount,
         sum(case when t.direction = 'out' then t.amount end) as out_amount,
         sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end) as net,
         count(*) as transfers,
         min(t.block_time) as first_at, max(t.block_time) as last_at
  from transactions t
  join wallets w on w.sol_address_key = t.address_key
  join chains c on c.network_id = t.network_id
  left join tokens tk on tk.network_id = t.network_id and tk.token_key = t.token_key
  where w.handle in (${marks(k)})
    and t.network_id = ?
    and t.direction in ('in', 'out')
    and t.amount is not null
    and t.block_time >= ?
  group by w.handle, c.name, tk.address, t.token_key
  order by w.handle,
           abs(sum(case t.direction when 'in' then t.amount when 'out' then -t.amount end)) desc`;

Deno.test("/flow: wallets-first answers the rows the transactions-first statement did", async () => {
  const fifty = ["a", "b", "c", "d", ...Array.from({ length: 46 }, (_v, i) => `nobody${i}`)];
  for (const handles of [["a"], ["c"], ["nobody"], ["a", "b", "c", "d", "nobody"], fifty]) {
    const old = all(OLD_FLOW(handles.length), ...handles, SOL, SINCE);
    const got = [...await flowRows(handles, SINCE)].map((r) => ({ ...r }));
    assertEquals(got, old, handles.join(","));
  }
  const old = all(OLD_FLOW(2), "a", "b", SOL, SINCE);
  assertEquals(old.map((r) => `${r.handle}|${r.token_key}|${r.token_address}|${r.net}|${r.transfers}`), [
    "a|mint3|null|-8.5|2",              // s-4 out 7 and s-ab out 1.5; null amount, 'self' and null time are not flow
    "a|mint1cased|Mint1Cased|3.5|4",    // the row AT `since` counts, the one before it does not
    "a|mint2unknown|null|3|1",
    "b|mint3|null|1.5|1",
  ]);
});

// ------------------------------------------------------------------ /trades fees
const OLD_FEES = (k: number): string => `select network_id, tx_hash, fee_native, fee_native_symbol
          from transaction_fees
          where tx_hash in (${marks(k)})`;

Deno.test("/trades: fees sought by (network_id, tx_hash) are the fees the hash-only read served", async () => {
  type Trade = { networkId: number; txHash: string; feeNative: number | null; feeNativeSymbol: string | null; whyNoFee: string | null };
  for (const [path, expectCount] of [["/v2/traders/a/trades", 3], ["/v2/traders/a/trades?limit=2", 2], ["/v2/traders/d/trades?limit=500", 120], ["/v2/traders/c/trades", 0]] as const) {
    const trades = (await getJson(path)).trades as Trade[];
    assertEquals(trades.length, expectCount, path);
    const hashes = trades.map((t) => t.txHash);
    const old = new Map(all(OLD_FEES(hashes.length), ...hashes).map((f) => [`${f.network_id}|${f.tx_hash}`, f]));
    for (const t of trades) {
      const f = old.get(`${t.networkId}|${t.txHash}`) ?? null;
      assertEquals([t.feeNative, t.feeNativeSymbol], [f?.fee_native ?? null, f?.fee_native_symbol ?? null], `${path} ${t.txHash}`);
      assertEquals(t.whyNoFee === "no fee has been read for this transaction yet", f === null, `${path} ${t.txHash}`);
    }
  }
  const a = new Map(((await getJson("/v2/traders/a/trades")).trades as Trade[]).map((t) => [t.txHash, t]));
  assertEquals([a.get("h1")!.feeNative, a.get("h1")!.feeNativeSymbol], [0.001, "ETH"], "its own chain's fee, not bsc's 9 or solana's 8");
  assertEquals(a.get("h2")!.feeNative, null, "absent stays null");
  assertEquals(a.get("s1")!.feeNative, 0.000005);
  const d = (await getJson("/v2/traders/d/trades?limit=500")).trades as Trade[];
  assertEquals(d.filter((t) => t.feeNative !== null).length, 60, "numbers bound through json_each still match network_id");
});

// ------------------------------------------------------------------ /events
type Filters = { kind?: string; net?: number; handle?: string };
/* The statement that sought from since, carrying the fourth keyset column (sub) the route gained the same day: on three, both lost a transaction's legs at a page edge. */
const OLD_EVENTS = (f: Filters, cur: EventCursor | null): string => `
    with ev as (
      select 'transfer' as kind, tx.block_time as at, tx.tx_hash as id,
             w.handle || '|' || tx.network_id || '|' || tx.address_key || '|' || tx.transfer_key as sub, w.handle,
             tx.network_id, tx.direction, tx.token_key as token_address, tx.amount,
             tx.counterparty, tx.tx_source as source, tx.tx_type,
             null as token_delta, null as quote_delta, null as quote_usd,
             null as total_usd, null as refused_reason
      from transactions tx
      join wallets w on tx.address_key in (w.evm_address_key, w.sol_address_key)
      where tx.block_time is not null
      union all
      select 'swap', ws.block_time, ws.tx_hash,
             w.handle || '|' || ws.network_id || '|' || ws.address_key, w.handle,
             ws.network_id, null, ws.token_key, null, null, null, null,
             ws.token_delta, ws.quote_delta, ws.quote_usd, null, null
      from wallet_swaps ws
      join wallets w on ws.address_key in (w.evm_address_key, w.sol_address_key)
      where ws.block_time is not null
      union all
      -- JS cursors carry milliseconds; sampled_at is already stored to the millisecond,
      -- so date_trunc('milliseconds', …) has nothing left to do.
      select 'reading', s.sampled_at, s.handle, '', s.handle,
             null, null, null, null, null, null, null,
             null, null, null, s.total_usd, s.refused_reason
      from aum_samples s
      where s.basis = 'sampled'
    )
    select ev.*, c.name as chain, t.display_handle, t.source as trader_source,
           (ti.token_key is not null) as has_info, ti.is_honeypot, ti.can_not_sell
    from ev
    join traders t using (handle)
    left join chains c using (network_id)
    left join token_info ti on ti.network_id = ev.network_id and ti.token_key = ev.token_address
    where ev.at >= ?
      ${f.kind === undefined ? "" : "and ev.kind = ?"}
      ${f.net === undefined ? "" : "and ev.network_id = ?"}
      ${f.handle === undefined ? "" : "and ev.handle = ?"}
      ${cur === null ? "" : "and (ev.at, ev.kind, ev.id, ev.sub) > (?, ?, ?, ?)"}
    order by ev.at, ev.kind, ev.id, ev.sub
    limit ?`;

const oldEvents = (f: Filters, since: string, cur: EventCursor | null, limit: number): EventRow[] =>
  all(OLD_EVENTS(f, cur),
    since, ...(f.kind === undefined ? [] : [f.kind]), ...(f.net === undefined ? [] : [f.net]),
    ...(f.handle === undefined ? [] : [f.handle]), ...(cur === null ? [] : [cur.at, cur.kind, cur.id, cur.sub]), limit) as unknown as EventRow[];

/** Pages the NEW route to its end, checking every page and every cursor against the OLD statement. */
const walk = async (query: string, f: Filters, since: string, limit: number): Promise<number> => {
  let cur: EventCursor | null = null;
  let served = 0;
  for (let page = 0; page < 100; page++) {
    const old = oldEvents(f, since, cur, limit);
    const at: string = cur === null ? "" : `&cursor=${encodeURIComponent(encodeEventCursor(cur))}`;
    const body = await getJson(`/v2/events?since=${since}&limit=${limit}${query}${at}`);
    assertEquals(body.events, JSON.parse(JSON.stringify(old.map(toEvent))), `${query} page ${page}`);
    served += old.length;
    const last = old.at(-1);
    const next: EventCursor | null = old.length === limit && last
      ? { at: new Date(String(last.at)).toISOString(), kind: last.kind, id: last.id, sub: last.sub } : null;
    assertEquals(body.nextCursor, next === null ? null : encodeEventCursor(next), `${query} cursor after page ${page}`);
    if (next === null) return served;
    cur = next;
  }
  throw new Error("the feed never ended");
};

Deno.test("/events: seeking from the cursor serves the pages, and hands out the cursors, that seeking from since did", async () => {
  assert(await walk("", {}, SINCE, 7) > 120, "transfers, swaps and readings, d's 120 swaps included");
  assert(await walk("", {}, SINCE, 2) > 120, "a page edge inside every tie");
  assert(await walk("&handle=a", { handle: "a" }, SINCE, 3) >= 12);
  assert(await walk("&handle=c", { handle: "c" }, SINCE, 3) === 0, "a trader with no rows");
  assert(await walk("&kind=transfer&chain=solana&handle=a", { kind: "transfer", net: SOL, handle: "a" }, SINCE, 2) >= 8);
  assert(await walk("&kind=reading", { kind: "reading" }, SINCE, 1) === 2, "the rebuilt row and the one before since are not readings");
  assert(await walk("&kind=swap&chain=ethereum", { kind: "swap", net: 1 }, "2026-09-06T01:00:00.000Z", 50) === 60);
});

Deno.test("/events: a cursor OLDER than since does not reopen the window", async () => {
  const cur: EventCursor = { at: "2026-08-01T00:00:00.000Z", kind: "transfer", id: "", sub: "" };
  const old = oldEvents({}, SINCE, cur, 500);
  const body = await getJson(`/v2/events?since=${SINCE}&limit=500&cursor=${encodeURIComponent(encodeEventCursor(cur))}`);
  assertEquals(body.events, JSON.parse(JSON.stringify(old.map(toEvent))));
  assert(!old.some((r) => r.id === "s-old"), "the transfer of 15 Aug stays outside");
});
