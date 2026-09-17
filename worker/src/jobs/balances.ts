import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { SOLANA_NETWORK_ID, evmBalances, solanaBalances } from "../../../supabase/functions/_shared/chain_reads.ts";
import { IMPLIED_MCAP_CEILING_USD, MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, value } from "../../../supabase/functions/aum-sample/value.ts";
import { askable, positionRows, sliceSize, tradedKey, type Chain, type Row, type Traded, type Trader } from "./balances-core";

/**
 * Chain balances, the Worker half of refresh.yml's "Read chain balances" and "Close trades the
 * wallet no longer holds" steps: `scripts/load_chain_balances.mjs` then `close_stale_trades.mjs`.
 *
 * TWIN OF THOSE TWO SCRIPTS: edit both. Same reads (`_shared/chain_reads.ts`), same ceilings
 * (`aum-sample/value.ts`), same SQL. Differs only where the platform does: a slice of the
 * stalest traders per run instead of the whole roster, a trader's chains read in parallel, one
 * transaction per trader so a killed run keeps what it finished, a wall-clock budget, a failed
 * chain counted rather than fatal, the re-price and the trade close scoped to this run.
 */

type Sql = postgres.Sql;

export interface BalancesSummary {
  /** Traders whose chains were asked this run. */
  readonly traders: number;
  /** (trader, chain) reads that answered. */
  readonly chainsRead: number;
  /** (trader, chain) reads that threw; nothing is written for that chain, so its previous capture stays current. */
  readonly chainsFailed: number;
  /** holdings rows written with source = 'chain'. */
  readonly rowsWritten: number;
  /** Rows of this run's capture valued by the trailing re-price pass. */
  readonly repriced: number;
  /** Open trades marked closed_by_balance for the traders read. */
  readonly tradesClosed: number;
  /** Traders with a wallet whose newest chain capture is older than this run. Zero means the roster is current. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

interface ChainAnswer { readonly rows: Row[]; readonly learned: ReadonlyMap<string, number> }

/** Stalest first: max(holdings.captured_at) where source = 'chain', never read first. */
async function targets(sql: Sql, limit: number): Promise<Trader[]> {
  const rows = await sql<{ handle: string; sol_address: string | null; evm_address: string | null }[]>`
    select t.handle, w.sol_address, w.evm_address
    from traders t
    join wallets w on w.handle = t.handle
    left join lateral (
      select max(captured_at) as last_at from holdings h
      where h.handle = t.handle and h.source = 'chain') h on true
    where w.sol_address is not null or w.evm_address is not null
    order by h.last_at asc nulls first, t.handle
    limit ${limit}`;
  return rows.map((r) => ({ handle: r.handle, sol_address: r.sol_address, evm_address: r.evm_address }));
}

/** Every EVM token any target has traded, grouped by chain. One query, not one per trader. */
async function tradedByChain(sql: Sql, handles: readonly string[]): Promise<Map<string, Traded[]>> {
  const rows = await sql<{ handle: string; network_id: string; token_key: string; address: string }[]>`
    select tr.handle, tr.network_id::bigint, tr.token_key, min(tr.token_address) as address
    from trades tr
    where tr.handle = any(${handles}) and tr.network_id <> ${SOLANA_NETWORK_ID}
    group by 1,2,3`;
  const m = new Map<string, Traded[]>();
  for (const r of rows) {
    const k = tradedKey(r.handle, Number(r.network_id));
    m.set(k, [...(m.get(k) ?? []), { token_key: r.token_key, address: r.address }]);
  }
  return m;
}

/** Known decimals for the tokens in hand, keyed `network_id:token_key`. Scoped to the slice, as the sampler scopes it. */
async function knownDecimals(sql: Sql, traded: ReadonlyMap<string, readonly Traded[]>): Promise<Map<string, number>> {
  const keys = [...new Set([...traded.values()].flat().map((t) => t.token_key))];
  const m = new Map<string, number>();
  if (!keys.length) return m;
  const rows = await sql<{ network_id: string; token_key: string; decimals: number }[]>`
    select network_id::bigint, token_key, decimals from tokens
    where token_key = any(${keys}) and decimals is not null`;
  for (const r of rows) m.set(`${r.network_id}:${r.token_key}`, Number(r.decimals));
  return m;
}

/** One chain for one trader. Throws on a read fault; the caller counts it. */
async function readChain(
  helius: string, t: Trader, c: Chain, decimals: Map<string, number>, traded: ReadonlyMap<string, readonly Traded[]>,
): Promise<ChainAnswer> {
  const net = c.network_id;
  if (net === SOLANA_NETWORK_ID) {
    const bals = await solanaBalances(t.sol_address ?? "", helius);
    if (bals === null) throw new Error("HELIUS_SOLANA_KEY is not set");
    return { rows: positionRows(t.handle, net, bals), learned: new Map() };
  }
  const view = {
    get: (k: string) => decimals.get(`${net}:${k}`),
    set: (k: string, v: number) => { decimals.set(`${net}:${k}`, v); },
  };
  const { balances, learned } = await evmBalances(c.rpc, t.evm_address ?? "", [...(traded.get(tradedKey(t.handle, net)) ?? [])], view);
  return { rows: positionRows(t.handle, net, balances), learned: new Map([...learned].map(([k, v]) => [`${net}:${k}`, v])) };
}

/** The .mjs write, verbatim, for one trader's rows. Returns the holdings rows written. */
async function writeRows(sql: Sql, capturedAt: Date, rows: readonly Row[], learned: ReadonlyMap<string, number>): Promise<number> {
  if (!rows.length) return 0;
  return await sql.begin(async (tx) => {
    // FK: holdings -> tokens. A mint we have never seen is still a real position.
    await tx`
      insert into tokens (network_id, address)
      select * from unnest(${rows.map((r) => r.network_id)}::bigint[], ${rows.map((r) => r.address)}::text[])
      on conflict (network_id, token_key) do nothing`;

    if (learned.size) {
      const nets: number[] = [], keys: string[] = [], decs: number[] = [];
      for (const [k, v] of learned) { const i = k.indexOf(":"); nets.push(Number(k.slice(0, i))); keys.push(k.slice(i + 1)); decs.push(v); }
      await tx`
        update tokens t set decimals = u.d
        from unnest(${nets}::bigint[], ${keys}::text[], ${decs}::smallint[]) as u(n, k, d)
        where t.network_id = u.n and t.token_key = u.k and t.decimals is null`;
    }

    /** Price from what we already hold, and leave NULL where we hold nothing; an unpriced position is still written (the portfolio route reports the gap as `pricedShare`). */
    const priced = await tx<{ handle: string; network_id: string; token_key: string; human_amount: string; price: string | null; supply: number | null }[]>`
      select i.handle, i.network_id, i.token_key, i.human_amount,
             coalesce(qa.pegged_usd, ti.price_usd, tp.usd) as price,
             tk.total_supply::float8 as supply
      from unnest(${rows.map((r) => r.handle)}::text[], ${rows.map((r) => r.network_id)}::bigint[],
                  ${rows.map((r) => r.token_key)}::text[], ${rows.map((r) => r.amount)}::numeric[])
           as i(handle, network_id, token_key, human_amount)
      -- pegged_usd FIRST and deliberately: a dollar-pegged asset is a dollar, and neither token_info nor token_prices carries a stablecoin row.
      left join quote_assets qa
             on qa.network_id = i.network_id and qa.token_key = i.token_key
      left join token_info ti
             on ti.network_id = i.network_id and ti.token_key = i.token_key and ti.price_usd is not null
      left join lateral (
        select usd from token_prices p
        where p.network_id = i.network_id and p.token_key = i.token_key
        order by day desc limit 1
      ) tp on true
      left join tokens tk on tk.network_id = i.network_id and tk.token_key = i.token_key`;

    // The sampler's value(): the same ceilings, so /positions cannot show a figure a reading would refuse. A refused price stays on the row; only its value is withheld.
    const values = priced.map((r) =>
      value(Number(r.human_amount), r.price === null ? null : Number(r.price), r.supply).usd ?? null);

    const ins = await tx`
      insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value, source)
      select handle, network_id, token_key, ${capturedAt}::timestamptz, human_amount, price, value, 'chain'
      from unnest(${priced.map((r) => r.handle)}::text[], ${priced.map((r) => r.network_id)}::bigint[], ${priced.map((r) => r.token_key)}::text[],
                  ${priced.map((r) => r.human_amount)}::numeric[], ${priced.map((r) => r.price)}::numeric[], ${values}::numeric[])
           as t(handle, network_id, token_key, human_amount, price, value)
      on conflict (handle, network_id, token_key, captured_at) do update
        set human_amount = excluded.human_amount, price = excluded.price,
            value = excluded.value, source = excluded.source
      returning value`;
    return ins.length;
  });
}

/**
 * Re-price anything we could not value at insert time, scoped to this run's capture
 * (REVIEW_EFFICIENCY_17_SEP item 12). Only rows never valued are touched: a stored price is
 * a measurement, and the same ceilings as value() apply, so a REFUSED price is not re-priced past them.
 */
async function reprice(sql: Sql, capturedAt: Date): Promise<number> {
  const r = await sql`
    update holdings h
       set price = p.px, value = h.human_amount * p.px
      from (
        select t.network_id, t.token_key, t.total_supply,
               coalesce(qa.pegged_usd, ti.price_usd, tp.usd) as px
        from tokens t
        left join quote_assets qa on qa.network_id = t.network_id and qa.token_key = t.token_key
        left join token_info  ti on ti.network_id = t.network_id and ti.token_key = t.token_key
                                and ti.price_usd is not null
        left join lateral (select usd from token_prices x
                           where x.network_id = t.network_id and x.token_key = t.token_key
                           order by day desc limit 1) tp on true
      ) p
     where h.source = 'chain' and h.value is null and h.human_amount is not null
       and h.captured_at = ${capturedAt}::timestamptz
       and p.network_id = h.network_id and p.token_key = h.token_key and p.px is not null
       and p.px <= ${MAX_PRICE_PER_TOKEN}
       and h.human_amount * p.px <= ${MAX_POSITION_USD}
       and (p.total_supply is null or p.total_supply = 0 or p.px * p.total_supply <= ${IMPLIED_MCAP_CEILING_USD})`;
  return r.count;
}

/**
 * close_stale_trades.mjs for the traders just read: an open trade on a (trader, chain) read
 * within 36 h whose token that read did not find is closed by balance. A chain that was not
 * read is never touched: "no row" only means "sold" when the read happened.
 */
async function closeStaleTrades(sql: Sql, handles: readonly string[]): Promise<number> {
  const closed = await sql`
    update trades set status = 'closed_by_balance', closed_by = 'balance'
    where trade_id in (
      select tr.trade_id
      from trades tr
      where tr.handle = any(${handles})
        and tr.status not in ('closed', 'closed_by_balance')
        and exists (select 1 from holdings h
                    where h.handle = tr.handle and h.network_id = tr.network_id
                      and h.source = 'chain' and h.captured_at > now() - interval '36 hours')
        and not exists (select 1 from holdings_current hc
                        where hc.handle = tr.handle and hc.network_id = tr.network_id
                          and hc.token_key = tr.token_key and hc.human_amount > 0))`;
  // fomo closed it itself since; its verdict wins and the balance mark is stale.
  await sql`
    update trades set closed_by = null
    where handle = any(${handles}) and closed_by is not null and status <> 'closed_by_balance'`;
  return closed.count;
}

/**
 * One slice of the stalest traders within `budgetMs`. Throws only when chains were asked and
 * none answered, so the cron shows as failed rather than quietly writing nothing.
 */
export async function runBalances(env: Env, budgetMs: number): Promise<BalancesSummary> {
  const started = Date.now();
  const helius = (env.HELIUS_SOLANA_KEY ?? "").trim();
  const sql = db(env);
  try {
    const slice = await targets(sql, sliceSize(env.BALANCE_SLICE));
    const chains = (await sql<{ network_id: string; name: string; rpc: string }[]>`
      select network_id::bigint, name, rpc from chains order by network_id`)
      .map((c): Chain => ({ network_id: Number(c.network_id), name: c.name, rpc: c.rpc }));
    const traded = await tradedByChain(sql, slice.map((t) => t.handle));
    const decimals = await knownDecimals(sql, traded);

    const capturedAt = new Date();
    const read: string[] = [];
    let chainsRead = 0, chainsFailed = 0, rowsWritten = 0, stoppedEarly = false;
    // ponytail: an emptied wallet writes no row, so its capture never advances and it keeps a slot at the head of the queue; record empty reads if that ever costs slots.
    for (const t of slice) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      read.push(t.handle);
      const ask = askable(t, chains, traded);
      /* Chains in parallel: the per-host throttle in chain_reads serialises same-host calls, so this is safe. */
      const answers = await Promise.allSettled(ask.map((c) => readChain(helius, t, c, decimals, traded)));
      const rows: Row[] = [], learned = new Map<string, number>();
      answers.forEach((a, i) => {
        if (a.status === "fulfilled") {
          chainsRead += 1;
          rows.push(...a.value.rows);
          for (const [k, v] of a.value.learned) learned.set(k, v);
        } else {
          chainsFailed += 1;
          console.error(`balances: ${t.handle} ${ask[i].name}: ${a.reason instanceof Error ? a.reason.message : String(a.reason)}`);
        }
      });
      try {
        rowsWritten += await writeRows(sql, capturedAt, rows, learned);
      } catch (e) {
        console.error(`balances: ${t.handle} write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (chainsRead === 0 && chainsFailed > 0) throw new Error(`balances: all ${chainsFailed} chain reads failed`);

    const repriced = rowsWritten ? await reprice(sql, capturedAt) : 0;
    const tradesClosed = read.length ? await closeStaleTrades(sql, read) : 0;
    const [pending] = await sql<{ n: number }[]>`
      select count(*)::int as n
      from traders t
      join wallets w on w.handle = t.handle
      left join lateral (
        select max(captured_at) as last_at from holdings h
        where h.handle = t.handle and h.source = 'chain') h on true
      where (w.sol_address is not null or w.evm_address is not null)
        and (h.last_at is null or h.last_at < ${capturedAt}::timestamptz)`;
    return {
      traders: read.length, chainsRead, chainsFailed, rowsWritten, repriced, tradesClosed,
      remaining: Number(pending?.n ?? 0), stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
