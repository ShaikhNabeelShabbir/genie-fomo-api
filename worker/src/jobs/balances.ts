import type postgres from "postgres";
import type { Env } from "../env";
import { db } from "../db";
import { SOLANA_NETWORK_ID, solanaBalances } from "../../../supabase/functions/_shared/chain_reads.ts";
import { evmBalancesBitquery, evmTxCount } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS } from "../../../supabase/functions/_shared/settings.ts";
import { IMPLIED_MCAP_CEILING_USD, MAX_POSITION_USD, MAX_PRICE_PER_TOKEN, value } from "../../../supabase/functions/aum-sample/value.ts";
import { askable, positionRows, sliceSize, type Chain, type Row, type Trader } from "./balances-core";

/**
 * Chain balances, the Worker half of refresh.yml's "Read chain balances" and "Close trades the
 * wallet no longer holds" steps: `scripts/load_chain_balances.mjs` then `close_stale_trades.mjs`.
 *
 * TWIN OF THOSE TWO SCRIPTS: edit both. Same Solana read (`_shared/chain_reads.ts`), same
 * ceilings (`aum-sample/value.ts`), same SQL. Differs where the platform does: EVM chains are
 * read through Bitquery (`_shared/bitquery.ts`; public RPCs 429 Cloudflare's egress), so every
 * held token comes back and no traded-token list is needed; a slice of the stalest traders per
 * run instead of the whole roster, a trader's chains read in parallel, one transaction per
 * trader so a killed run keeps what it finished, a wall-clock budget, a failed chain counted
 * rather than fatal, the re-price and the trade close scoped to this run.
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
  /** Tokens Bitquery returned that `tokens` had never seen: inserted minimally (network_id, address, decimals), the way the .mjs did. */
  readonly unknownTokens: number;
  /** Traders whose aum_live row was revalued after their capture (migration 20260918030000). */
  readonly liveRefreshed: number;
  /** Traders with a wallet whose newest chain capture is older than this run. Zero means the roster is current. */
  readonly remaining: number;
  readonly stoppedEarly: boolean;
  readonly elapsedMs: number;
}

interface ChainAnswer {
  readonly rows: Row[];
  readonly learned: ReadonlyMap<string, number>;
  /** R6: transactions the wallet sent, from Bitquery's realtime window (a lower bound); null on Solana or when the count failed. */
  readonly nonce: number | null;
}

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

/** One chain for one trader. Throws on a read fault; the caller counts it. */
async function readChain(keys: { helius: string; bitquery: string }, t: Trader, c: Chain): Promise<ChainAnswer> {
  const net = c.network_id;
  if (net === SOLANA_NETWORK_ID) {
    const bals = await solanaBalances(t.sol_address ?? "", keys.helius);
    if (bals === null) throw new Error("HELIUS_SOLANA_KEY is not set");
    return { rows: positionRows(t.handle, net, bals), learned: new Map(), nonce: null };
  }
  const word = EVM_CHAINS[net]?.bitquery;
  if (!word) throw new Error(`no Bitquery network for chain ${net}`);
  const wallet = t.evm_address ?? "";
  // The count is a diagnostic (R6): its failure is logged, never a failed chain read.
  const [{ balances }, nonce] = await Promise.all([
    evmBalancesBitquery(keys.bitquery, word, wallet),
    evmTxCount(keys.bitquery, word, wallet).catch((e: unknown) => {
      console.error(`balances: ${t.handle} ${c.name} tx count: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
  ]);
  // Decimals ride along with the balance; the write fills tokens.decimals where it is still null.
  const learned = new Map(balances.flatMap((b) => (b.decimals === null ? [] : [[`${net}:${b.address}`, b.decimals] as const])));
  return { rows: positionRows(t.handle, net, balances), learned, nonce };
}

/** R6: the sampler's chain_coverage write, one row per EVM chain that answered with a count, against the transfer rows held. */
async function writeCoverage(sql: Sql, t: Trader, counted: readonly { network_id: number; nonce: number }[]): Promise<void> {
  if (!counted.length || !t.evm_address) return;
  const addr = t.evm_address.toLowerCase();
  await sql`
    insert into chain_coverage (handle, network_id, address_key, chain_nonce, rows_held, read_at)
    select ${t.handle}, u.n, ${addr}, u.c,
           (select count(*) from transactions x where x.address_key = ${addr} and x.network_id = u.n), now()
    from unnest(${counted.map((c) => c.network_id)}::bigint[], ${counted.map((c) => c.nonce)}::bigint[]) as u(n, c)
    on conflict (handle, network_id) do update set
      address_key = excluded.address_key, chain_nonce = excluded.chain_nonce,
      rows_held = excluded.rows_held, read_at = excluded.read_at`;
}

/** The .mjs write, verbatim, for one trader's rows. Returns the holdings rows written and the tokens first seen. */
async function writeRows(
  sql: Sql, capturedAt: Date, rows: readonly Row[], learned: ReadonlyMap<string, number>,
): Promise<{ written: number; unknown: number }> {
  if (!rows.length) return { written: 0, unknown: 0 };
  return await sql.begin(async (tx) => {
    // FK: holdings -> tokens. A mint we have never seen is still a real position.
    const seen = await tx`
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
    const priced = await tx<{ handle: string; network_id: string; token_key: string; human_amount: string; price: string | null; price_source: string | null; supply: number | null }[]>`
      select i.handle, i.network_id, i.token_key, i.human_amount,
             coalesce(qa.pegged_usd, nullif(ti.price_usd, 0), tp.usd) as price,
             -- V1c: which rung priced it (vocabulary positions[].priceSource); a GMGN zero is no price (Z1b).
             case when qa.pegged_usd is not null then 'pegged'
                  when nullif(ti.price_usd, 0) is not null then 'token_info'
                  when tp.usd is not null then 'token_prices' end as price_source,
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
        where p.network_id = i.network_id and p.token_key = i.token_key and p.usd > 0
        order by day desc limit 1
      ) tp on true
      left join tokens tk on tk.network_id = i.network_id and tk.token_key = i.token_key`;

    // The sampler's value(): the same ceilings, so /positions cannot show a figure a reading would refuse. A refused price stays on the row; only its value is withheld.
    const values = priced.map((r) =>
      value(Number(r.human_amount), r.price === null ? null : Number(r.price), r.supply).usd ?? null);

    const ins = await tx`
      insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value, source, price_source, priced_at)
      select handle, network_id, token_key, ${capturedAt}::timestamptz, human_amount, price, value, 'chain',
             price_source, case when price is not null then now() end
      from unnest(${priced.map((r) => r.handle)}::text[], ${priced.map((r) => r.network_id)}::bigint[], ${priced.map((r) => r.token_key)}::text[],
                  ${priced.map((r) => r.human_amount)}::numeric[], ${priced.map((r) => r.price)}::numeric[], ${values}::numeric[],
                  ${priced.map((r) => r.price_source)}::text[])
           as t(handle, network_id, token_key, human_amount, price, value, price_source)
      on conflict (handle, network_id, token_key, captured_at) do update
        set human_amount = excluded.human_amount, price = excluded.price,
            value = excluded.value, source = excluded.source,
            price_source = excluded.price_source, priced_at = excluded.priced_at
      returning value`;
    return { written: ins.length, unknown: seen.count };
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
       set price = p.px, value = h.human_amount * p.px, price_source = p.src, priced_at = now()
      from (
        select t.network_id, t.token_key, t.total_supply,
               coalesce(qa.pegged_usd, nullif(ti.price_usd, 0), tp.usd) as px,
               case when qa.pegged_usd is not null then 'pegged'
                    when nullif(ti.price_usd, 0) is not null then 'token_info'
                    when tp.usd is not null then 'token_prices' end as src
        from tokens t
        left join quote_assets qa on qa.network_id = t.network_id and qa.token_key = t.token_key
        left join token_info  ti on ti.network_id = t.network_id and ti.token_key = t.token_key
                                and ti.price_usd is not null
        left join lateral (select usd from token_prices x
                           where x.network_id = t.network_id and x.token_key = t.token_key and x.usd > 0
                           order by day desc limit 1) tp on true
      ) p
     where h.source = 'chain' and h.value is null and h.human_amount is not null
       and h.captured_at = ${capturedAt}::timestamptz
       and p.network_id = h.network_id and p.token_key = h.token_key and p.px > 0
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
  const keys = { helius: (env.HELIUS_SOLANA_KEY ?? "").trim(), bitquery: (env.BITQUERY_KEY ?? "").trim() };
  if (!keys.bitquery) throw new Error("balances: BITQUERY_KEY is not set; EVM chains are read through Bitquery");
  const sql = db(env);
  try {
    const slice = await targets(sql, sliceSize(env.BALANCE_SLICE));
    const chains = (await sql<{ network_id: string; name: string; rpc: string }[]>`
      select network_id::bigint, name, rpc from chains order by network_id`)
      .map((c): Chain => ({ network_id: Number(c.network_id), name: c.name, rpc: c.rpc }));
    const capturedAt = new Date();
    const read: string[] = [];
    let chainsRead = 0, chainsFailed = 0, rowsWritten = 0, unknownTokens = 0, liveRefreshed = 0, stoppedEarly = false;
    // ponytail: an emptied wallet writes no row, so its capture never advances and it keeps a slot at the head of the queue; record empty reads if that ever costs slots.
    for (const t of slice) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      read.push(t.handle);
      const ask = askable(t, chains);
      /* Chains in parallel: the per-host throttle in chain_reads serialises same-host calls, so this is safe. */
      const answers = await Promise.allSettled(ask.map((c) => readChain(keys, t, c)));
      const rows: Row[] = [], learned = new Map<string, number>(), counted: { network_id: number; nonce: number }[] = [];
      answers.forEach((a, i) => {
        if (a.status === "fulfilled") {
          chainsRead += 1;
          rows.push(...a.value.rows);
          for (const [k, v] of a.value.learned) learned.set(k, v);
          if (a.value.nonce !== null) counted.push({ network_id: ask[i].network_id, nonce: a.value.nonce });
        } else {
          chainsFailed += 1;
          console.error(`balances: ${t.handle} ${ask[i].name}: ${a.reason instanceof Error ? a.reason.message : String(a.reason)}`);
        }
      });
      try {
        const w = await writeRows(sql, capturedAt, rows, learned);
        rowsWritten += w.written; unknownTokens += w.unknown;
        await writeCoverage(sql, t, counted);
        // The capture is in; revalue this trader's current AUM from it (aum_live, migration 20260918030000).
        const [live] = await sql<{ n: number }[]>`select aum_live_refresh(${[t.handle]}::text[], 'balances') as n`;
        liveRefreshed += Number(live?.n ?? 0);
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
      traders: read.length, chainsRead, chainsFailed, rowsWritten, unknownTokens, repriced, tradesClosed, liveRefreshed,
      remaining: Number(pending?.n ?? 0), stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
