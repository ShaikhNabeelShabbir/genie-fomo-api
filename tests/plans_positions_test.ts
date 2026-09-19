import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import "../supabase/functions/api/routes.ts";
import { n } from "../supabase/functions/api/db.ts";
import { type NativePrice, nativePrices, readNativePrices } from "../supabase/functions/api/shared/prices.ts";
import { oldestUsableDay } from "../supabase/functions/api/shared/price-ladder.ts";

/*
 * EQUIVALENCE of the three statements the positions family rewrote on 19 Sep 2026 to stop
 * reading whole tables: each OLD text runs verbatim beside the new code path, over rows seeded
 * for the edge cases, and the rows must be equal — in the order they come back.
 */

const SOL = 1399811149;
const ZERO = "0x0000000000000000000000000000000000000000";
const WETH_ETHEREUM = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WETH_ROBINHOOD = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const WSOL = "so11111111111111111111111111111111111111112";
const MINT_HELD = "mintheld";
const MINT_NEW = "mintnew";
const MINT_NEW_2 = "mintnew2";

const prepared: string[] = [];
const db = await openSchema((text) => void prepared.push(text));
const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
const all = (text: string, ...p: (string | number | null)[]): Record<string, unknown>[] =>
  db.prepare(text).all(...p) as Record<string, unknown>[];

const trader = (h: string, sol: string | null): void => {
  run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h.toUpperCase(), `id-${h}`);
  run("insert into wallets (handle, evm_address, sol_address) values (?,?,?)", h, `0xW${h}`, sol);
};
const token = (net: number, key: string): void =>
  run("insert or ignore into tokens (network_id, address, token_key, total_supply) values (?,?,?,1000000)", net, key, key);
const holding = (
  h: string, net: number, key: string, at: string, amount: number,
  source: "chain" | "fomo" = "chain", price: number | null = null, priceSource: string | null = null, pricedAt: string | null = null,
): void => {
  token(net, key);
  run(`insert into holdings (handle, network_id, token_key, captured_at, human_amount, source, price, price_source, priced_at)
       values (?,?,?,?,?,?,?,?,?)`, h, net, key, at, amount, source, price, priceSource, pricedAt);
};
let transfers = 0;
const transfer = (wallet: string, key: string | null, direction: string | null, amount: number | null, at: string | null): void =>
  run(`insert into transactions (network_id, tx_hash, address_key, block_time, direction, token_key, amount, source, transfer_key)
       values (?,?,?,?,?,?,?,'helius',?)`, SOL, `tx-${++transfers}`, wallet.toLowerCase(), at, direction, key, amount, `k-${transfers}`);

// ------------------------------------------------------------ nativePrices

/** The statement nativePrices issued until 19 Sep 2026, verbatim. */
const OLD_NATIVE_PRICES = `
    with native as (
      select c.network_id, c.name, c.native_symbol,
             -- The key that HAS a price first: the native sentinel (0x000…0) must not shadow a priced WETH/WBNB.
             -- SQLite refuses an outer reference in a subquery's ORDER BY, so both ranks
             -- are computed as columns of a derived table and ordered by name.
             (select token_key from (
                select q.token_key,
                       (exists (select 1 from token_prices p
                                 where p.network_id = q.network_id
                                   and p.token_key = q.token_key)) as priced,
                       (upper(q.symbol) = upper(c.native_symbol)) as exact_symbol
                  from quote_assets q
                 where q.network_id = c.network_id
                   and upper(q.symbol) in ('W' || upper(c.native_symbol), upper(c.native_symbol)))
               order by priced desc, exact_symbol desc
               limit 1) as token_key
      from chains c)
    select n.network_id, n.native_symbol,
           coalesce(tp.usd, hp.price, xc.usd) as usd,
           case when tp.usd is not null then 'token_prices_daily'
                when hp.price is not null then hp.price_source
                when xc.usd is not null then xc.source || ' (via ' || xc.chain || ')'
                else null end as source
    from native n
    -- Each Postgres left join lateral (... limit 1) is the rn = 1 row of the same ordering.
    left join (
      select network_id, token_key, usd,
             row_number() over (partition by network_id, token_key order by day desc) as rn
      from token_prices) tp
      on tp.network_id = n.network_id and tp.token_key = n.token_key and tp.rn = 1
    left join (
      select h.network_id, h.token_key, h.price, h.price_source,
             row_number() over (
               partition by h.network_id, h.token_key order by h.priced_at desc) as rn
      from holdings_current h
      where h.price is not null
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry') hp
      on hp.network_id = n.network_id and hp.token_key = n.token_key and hp.rn = 1
    /*
     * ETH IS ETH, whichever chain it is the native coin of.
     *
     * ethereum and base carry no market price for their own native in our store, while
     * robinhood's curated WETH is priced at 2,478.49 and Solana's at 2,497.98 -- two
     * independent sources agreeing within 0.8%, which is a real price for the asset rather
     * than a quirk of one chain. Refusing to use it would leave two chains unpriced for no
     * reason a reader would accept.
     *
     * Matched on the NATIVE SYMBOL against the curated quote assets only, never on any token
     * calling itself ETH: the store holds several impostors under that symbol, one of them
     * priced at 0.00. The chain it came from is named in the source string, so the borrowing
     * is visible rather than implied.
     *
     * The lateral was correlated on the native symbol rather than on a key, so the derived
     * table carries the symbol it serves and the outer join takes its newest priced row.
     */
    left join (
      select cn.native_symbol, h.price as usd, h.price_source as source, c2.name as chain,
             row_number() over (
               partition by upper(cn.native_symbol) order by h.priced_at desc) as rn
      from quote_assets q2
      join chains c2 on c2.network_id = q2.network_id
      join holdings_current h
        on h.network_id = q2.network_id and h.token_key = q2.token_key
      join (select distinct native_symbol from chains) cn
        on upper(q2.symbol) in ('W' || upper(cn.native_symbol), upper(cn.native_symbol))
      where h.price is not null and h.price > 0
        and h.price_source is not null and h.price_source <> 'fomo_reported_entry') xc
      on upper(xc.native_symbol) = upper(n.native_symbol) and xc.rn = 1`;

const oldNativePrices = (): Map<number, NativePrice> =>
  new Map(all(OLD_NATIVE_PRICES).map((r) => [Number(r.network_id), {
    symbol: String(r.native_symbol), usd: n(r.usd), source: r.source ? String(r.source) : null,
  }]));

Deno.test("nativePrices answers what the windowed statement did, by seeks", async () => {
  run("insert into chains (network_id, name, native_symbol) values (999,'nowhere','XYZ')"); // no quote asset at all
  assertEquals(await readNativePrices(), oldNativePrices(), "no prices, no holdings: every chain unpriced");
  assertEquals((await readNativePrices()).get(999), { symbol: "XYZ", usd: null, source: null });

  for (const h of ["na", "nb", "nc", "nd", "ne", "nf"]) trader(h, null);
  /* ethereum: an OLDER capture priced LATER is not current and must lose to the current rows. */
  holding("na", 1, ZERO, "2026-09-10T00:00:00.000Z", 1, "chain", 2000, "dexscreener", "2026-09-18T00:00:00.000Z");
  holding("na", 1, ZERO, "2026-09-17T00:00:00.000Z", 1, "chain", 2400, "dexscreener", "2026-09-17T01:00:00.000Z");
  holding("nb", 1, ZERO, "2026-09-16T00:00:00.000Z", 1, "chain", 2450, "dexscreener", "2026-09-17T02:00:00.000Z"); // newest current
  holding("ne", 1, ZERO, "2026-09-15T00:00:00.000Z", 1, "chain", 2450, "dexscreener", "2026-09-17T02:00:00.000Z"); // a tie, same figure
  holding("nc", 1, ZERO, "2026-09-17T00:00:00.000Z", 1, "chain", 9999, "fomo_reported_entry", "2026-09-19T00:00:00.000Z"); // never a market price
  holding("nd", 1, ZERO, "2026-09-17T00:00:00.000Z", 1, "chain", null, null, null); // unpriced
  holding("nd", 1, WETH_ETHEREUM, "2026-09-17T00:00:00.000Z", 1, "chain", 2300, "dexscreener", null); // priced, undated: sorts last
  /* nf's CURRENT capture shares its instant with na's STALE one (a slice stamps one): current is judged per trader. */
  holding("nf", 1, ZERO, "2026-09-10T00:00:00.000Z", 1, "chain", 2390, "dexscreener", "2026-09-10T01:00:00.000Z");
  /* robinhood: read by fomo only, so the newest BUILD is current and the older one is not. */
  holding("na", 4663, WETH_ROBINHOOD, "2026-09-01T00:00:00.000Z", 1, "fomo", 1111, "gmgn", "2026-09-18T12:00:00.000Z");
  holding("na", 4663, WETH_ROBINHOOD, "2026-09-12T00:00:00.000Z", 1, "fomo", 2478.49, "gmgn", "2026-09-17T03:00:00.000Z");
  /* bsc: a zero price is a price to the chain's own rung, and is refused by the borrowed one. */
  holding("nb", 56, ZERO, "2026-09-17T00:00:00.000Z", 1, "chain", 0, "dexscreener", "2026-09-17T04:00:00.000Z");
  /* base holds only a WETH priced at zero, last of all: no price of its own, and the borrowed rung must refuse that one, */
  holding("nb", 8453, WETH_BASE, "2026-09-17T00:00:00.000Z", 1, "chain", 0, "dexscreener", "2026-09-18T23:00:00.000Z");
  /* so it borrows ETH from whichever chain priced it last above zero (robinhood). */
  const held = await readNativePrices();
  assertEquals(held, oldNativePrices());
  assertEquals(held.get(1), { symbol: "ETH", usd: 2450, source: "dexscreener" });
  assertEquals(held.get(8453), { symbol: "ETH", usd: 2478.49, source: "gmgn (via robinhood)" });
  assertEquals(held.get(56), { symbol: "BNB", usd: 0, source: "dexscreener" });

  /* solana: two closes, the newer wins, and a daily close outranks every holdings price. */
  holding("na", SOL, WSOL, "2026-09-17T00:00:00.000Z", 1, "chain", 1, "dexscreener", "2026-09-19T00:00:00.000Z");
  run("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,'t')", SOL, WSOL, "2026-09-10", 140);
  run("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,'t')", SOL, WSOL, "2026-09-17", 150);
  run("insert into token_prices (network_id, token_key, day, usd, source) values (?,?,?,?,'t')", SOL, "mintunrelated", "2026-09-18", 7);
  const priced = await readNativePrices();
  assertEquals(priced, oldNativePrices());
  assertEquals(priced.get(SOL), { symbol: "SOL", usd: 150, source: "token_prices_daily" });
});

Deno.test("a priced_at tie goes to the row the windowed statement took, whatever order the rows are sought in", async () => {
  const BATCH = "2026-09-19T08:00:00.123Z"; // balances.ts stamps ONE priced_at on a trader's rows of EVERY chain
  const READ = "2026-09-19T08:00:00.000Z";
  const same = async (why: string): Promise<Map<number, NativePrice>> => {
    const now = await readNativePrices();
    assertEquals(now, oldNativePrices(), why);
    return now;
  };
  for (const h of ["solo", "aaa", "late", "fom"]) trader(h, null);
  /* One trader, one batch, two chains (the production case): ethereum before base, though base is stored and sought first; */
  holding("solo", 8453, WETH_BASE, READ, 1, "chain", 2449.87, "dexscreener", BATCH);
  holding("solo", 1, ZERO, READ, 1, "chain", 2450.12, "dexscreener", BATCH);
  holding("solo", 1, WETH_ETHEREUM, READ, 1, "chain", 2449.9, "dexscreener", BATCH); // and on one chain, the row stored first
  const batch = await same("one batch, two chains");
  assertEquals(batch.get(4663), { symbol: "ETH", usd: 2450.12, source: "dexscreener (via ethereum)" });
  assertEquals(batch.get(8453), { symbol: "ETH", usd: 2450.12, source: "dexscreener (via ethereum)" });

  /* Two traders priced in one instant: the lower HANDLE, not the lower chain and not the row stored first. */
  holding("aaa", 8453, WETH_BASE, READ, 1, "chain", 2449.55, "dexscreener", BATCH);
  assertEquals((await same("two traders")).get(4663), { symbol: "ETH", usd: 2449.55, source: "dexscreener (via base)" });
  /* A directory build priced in that instant loses to every chain read. */
  holding("fom", 4663, WETH_ROBINHOOD, "2026-09-12T00:00:00.000Z", 1, "fomo", 2451, "gmgn", BATCH);
  assertEquals((await same("a build ties a read")).get(4663)?.usd, 2449.55);

  /* The chain's OWN rung: of two reads priced in one instant the newer capture, not the row stored first; */
  holding("late", 1, ZERO, "2026-09-19T09:00:00.000Z", 1, "chain", 2460, "dexscreener", BATCH);
  holding("aaa", 1, ZERO, "2026-09-19T09:00:00.000Z", 1, "chain", 2461, "dexscreener", BATCH); // one capture too: stored first wins, NOT the lower handle
  assertEquals((await same("own rung, newer capture")).get(1), { symbol: "ETH", usd: 2460, source: "dexscreener" });
  /* and a chain read before a directory build, however much newer the build. */
  holding("late", 4663, ZERO, "2026-09-11T00:00:00.000Z", 1, "chain", 2441, "dexscreener", BATCH);
  holding("fom", 4663, ZERO, "2026-09-12T00:00:00.000Z", 1, "fomo", 2440, "gmgn", BATCH);
  assertEquals((await same("own rung, read before build")).get(4663), { symbol: "ETH", usd: 2441, source: "dexscreener" });
});

Deno.test("nativePrices is read once per TTL, whoever asks", async () => {
  const issued = (): number => prepared.filter((t) => t.includes("with native as")).length;
  const before = issued();
  const first = await nativePrices();
  assertEquals(issued(), before + 1);
  assert(await nativePrices() === first, "a second caller inside the TTL is served the same answer");
  assertEquals(issued(), before + 1);
  assertEquals(first, await readNativePrices());
});

// ----------------------------------------------------------- holdings_live

Deno.test("holdings_live (0007) returns the rows of the view it replaces, in the same order", async () => {
  /* The old view, verbatim from the migration that defined it. */
  const old = (await Deno.readTextFile(new URL("../worker/d1/migrations/0002_views.sql", import.meta.url)))
    .split("create view if not exists holdings_live as")[1].split(";")[0];
  db.exec(`create view holdings_live_old as ${old}`);

  trader("read", "SolRead"); trader("never", "SolNever"); trader("fomo", "SolFomo"); trader("evm", null); trader("idle", "SolIdle");
  /* read: an older and a newer chain capture, a second chain, transfers on both sides of the read. */
  holding("read", SOL, MINT_HELD, "2026-09-10T00:00:00.000Z", 5);
  holding("read", SOL, MINT_HELD, "2026-09-15T00:00:00.000Z", 10);
  holding("read", 1, ZERO, "2026-09-15T06:00:00.000Z", 2);
  token(SOL, MINT_NEW); token(SOL, MINT_NEW_2);
  transfer("SolRead", MINT_HELD, "in", 0.1, "2026-09-16T00:00:00.000Z");
  transfer("SolRead", MINT_HELD, "out", 0.2, "2026-09-16T00:00:00.000Z"); // same instant
  transfer("SolRead", MINT_HELD, "in", 99, "2026-09-12T00:00:00.000Z"); // before the newer read
  transfer("SolRead", MINT_NEW, "in", 0.1, "2026-09-16T01:00:00.000Z");
  transfer("SolRead", MINT_NEW, "in", 0.2, "2026-09-16T02:00:00.000Z");
  transfer("SolRead", MINT_NEW, "out", 0.3, "2026-09-16T03:00:00.000Z");
  transfer("SolRead", MINT_NEW, "in", 1e-9, "2026-09-16T04:00:00.000Z");
  transfer("SolRead", MINT_NEW, "in", 50, "2026-09-14T00:00:00.000Z"); // before the read: not a new position's
  transfer("SolRead", MINT_NEW, "in", 50, "2026-09-15T00:00:00.000Z"); // AT the read: not after it
  transfer("SolRead", MINT_NEW_2, "in", 7, "2026-09-16T01:00:00.000Z");
  transfer("SolRead", MINT_NEW_2, "self", 7, "2026-09-16T01:00:00.000Z"); // not a movement
  transfer("SolRead", MINT_NEW_2, "in", null, "2026-09-16T01:00:00.000Z"); // no amount
  transfer("SolRead", MINT_NEW_2, "in", 3, null); // undated: never after a read
  /* never: no balance read at all, so every transfer counts — the undated and the keyless too. */
  transfer("SolNever", MINT_NEW, "in", 4, "2026-09-01T00:00:00.000Z");
  transfer("SolNever", MINT_NEW, "out", 1, null);
  transfer("SolNever", null, "in", 2, "2026-09-02T00:00:00.000Z");
  /* fomo: Solana known from the directory build only; the newest build is the read. */
  holding("fomo", SOL, MINT_HELD, "2026-09-01T00:00:00.000Z", 1, "fomo");
  holding("fomo", SOL, MINT_HELD, "2026-09-12T00:00:00.000Z", 3, "fomo");
  transfer("SolFomo", MINT_HELD, "in", 2, "2026-09-13T00:00:00.000Z");
  transfer("SolFomo", MINT_NEW, "in", 6, "2026-09-05T00:00:00.000Z"); // between the builds: before the read
  transfer("SolFomo", MINT_NEW, "in", 8, "2026-09-13T00:00:00.000Z");
  /* evm: no Solana wallet. idle: a wallet and nothing else — no rows. */
  holding("evm", 1, ZERO, "2026-09-15T00:00:00.000Z", 1);

  const handles = ["read", "never", "fomo", "evm", "idle", "nobody"];
  for (const h of handles) {
    assertEquals(all("select * from holdings_live where handle = ?", h), all("select * from holdings_live_old where handle = ?", h), h);
  }
  const four = "where handle in (?,?,?,?)"; // refreshAumLive reads four traders a statement
  assertEquals(all(`select * from holdings_live ${four}`, ...handles.slice(0, 4)), all(`select * from holdings_live_old ${four}`, ...handles.slice(0, 4)));
  assertEquals(all("select * from holdings_live"), all("select * from holdings_live_old"));

  const fresh = all("select token_key, human_amount_live, delta_since, transfers_since_read from holdings_live where handle = 'read' and captured_at is null");
  assertEquals(fresh.map((r) => r.token_key), [MINT_NEW, MINT_NEW_2]);
  assertEquals(fresh[0].transfers_since_read, 4);
  assertEquals(fresh[1], { token_key: MINT_NEW_2, human_amount_live: 7, delta_since: "2026-09-15T00:00:00.000Z", transfers_since_read: 1 });
  assertEquals(all("select count(*) n from holdings_live where handle = 'never'")[0].n, 2);
  assertEquals(all("select count(*) n from holdings_live where handle in ('idle','nobody')")[0].n, 0);

  /* The point of the rewrite: the wallet's read time is found once, BEFORE its transfers are walked. */
  const plan = all("explain query plan select * from holdings_live where handle = ?").map((p) => String(p.detail));
  const readTime = plan.findIndex((d) => d.startsWith("SCAN sr VIRTUAL TABLE"));
  assert(readTime >= 0 && readTime < plan.findIndex((d) => d.startsWith("SEARCH t USING INDEX transactions_addr_token_time_idx")), plan.join("\n"));
});

// ------------------------------------------------------- GET /positions

/** The statement /positions issued until 19 Sep 2026, verbatim (its two values as parameters). */
const OLD_POSITIONS = `
    select tk.address, h.network_id, h.token_key, c.name as chain, h.human_amount, h.price, h.value,
           -- PRD §3: a price is only judgeable if it says where it came from and when it
           -- was true. A live quote and a three-week-old reported entry are both usable and
           -- are not the same claim.
           h.price_source, h.priced_at, h.captured_at, h.source as balance_source,
           (q.token_key is not null) as is_quote,
           ti.is_honeypot, ti.can_not_sell, ps.drawdown_share,
           cast(coalesce(nullif(tk.total_supply, 0), nullif(ti.total_supply, 0)) as real) as total_supply,
           -- V1d: the best pair's liquidity, latest hourly sample first, else GMGN's; null = no pair known.
           -- A correlated seek (19 Sep): the windowed join it replaces materialised ALL of
           -- token_price_hourly on every call, twice (once per branch of holdings_current) —
           -- 170k rows read against 26k without it, on the most-called route in the API.
           cast(coalesce((select tph.liquidity_usd from token_price_hourly tph
                          where tph.network_id = h.network_id and tph.token_key = h.token_key
                          order by tph.hour desc limit 1), ti.liquidity_usd) as real) as liquidity_usd,
           -- Workflow gap 4: Solana rolled forward from the webhook feed since the read.
           h.human_amount_live, h.delta, h.last_transfer_at,
             q.pegged_usd,
  ps.last_usd as stats_usd, ps.last_at as stats_at,
  ti.price_usd as info_usd, ti.fetched_at as info_at,
  -- Packed day|usd: two columns would be two correlated seeks on an 11,000-row list.
  (select tp.day || '|' || tp.usd from token_prices tp
    where tp.network_id = h.network_id and tp.token_key = h.token_key
      and tp.usd > 0 and tp.day >= ?
    order by tp.day desc limit 1) as daily
    from holdings_live h
    join tokens tk on tk.network_id = h.network_id and tk.token_key = h.token_key
    join chains c on c.network_id = h.network_id
    left join quote_assets q on q.network_id = h.network_id and q.token_key = h.token_key
    left join token_info ti on ti.network_id = h.network_id and ti.token_key = h.token_key
    left join token_price_stats ps on ps.network_id = h.network_id and ps.token_key = h.token_key
    where h.handle = ?`;

Deno.test("/positions reads the rows it read before, through the statement the route really issues", async () => {
  for (const h of ["read", "never", "fomo", "evm", "idle"]) {
    prepared.length = 0;
    const res = await handle(new Request(`https://test.local/v2/traders/${h}/positions`, { headers: { "user-agent": "plans-positions-test/1.0" } }));
    assertEquals(res.status, 200, await res.clone().text());
    await res.body?.cancel();
    const issued = prepared.filter((t) => t.includes("from holdings_live"));
    assertEquals(issued.length, 1);
    const params = [oldestUsableDay(new Date()), h];
    assertEquals(all(issued[0], ...params), all(OLD_POSITIONS, ...params), h);
  }
  assertEquals(all(OLD_POSITIONS, oldestUsableDay(new Date()), "read").length, 4, "two rows as read, two positions opened since");
});
