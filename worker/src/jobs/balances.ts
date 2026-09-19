import type { Env } from "../env";
import { jobSql, type Sql } from "../sql";
import { SOLANA_NETWORK_ID, solanaBalances } from "../../../supabase/functions/_shared/chain_reads.ts";
import { evmBalancesBitquery, evmTxCount } from "../../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS, REFUSALS_IN_A_ROW } from "../../../supabase/functions/_shared/settings.ts";
import { value } from "../../../supabase/functions/aum-sample/value.ts";
import { askable, balanceTargets, failedInARow, notAttemptedSince, positionRows, sliceSize, sourceOf, stampAttempt, type Chain, type Row, type Source, type Trader } from "./balances-core";
import { chunk } from "./directory-core";

/**
 * Chain balances, the Worker half of refresh.yml's "Read chain balances" and "Close trades the
 * wallet no longer holds" steps: `scripts/load_chain_balances.mjs` then `close_stale_trades.mjs`.
 *
 * TWIN OF THOSE TWO SCRIPTS: edit both. Same Solana read (`_shared/chain_reads.ts`), same
 * ceilings (`aum-sample/value.ts`), same rows. Differs where the platform does: EVM chains are
 * read through Bitquery (`_shared/bitquery.ts`; public RPCs 429 Cloudflare's egress), so every
 * held token comes back and no traded-token list is needed; a slice of the stalest traders per
 * run instead of the whole roster, a trader's chains read in parallel, a wall-clock budget, a
 * failed chain counted rather than fatal, the re-price and the trade close scoped to this run.
 * On D1 the pricing joins are bounded selects and the arithmetic is `value()` here; a trader's
 * write is a few `db.batch` transactions rather than one, so a killed run keeps whole batches.
 */

/** Ids per `in (…)`: D1 allows 100 bound parameters a statement. */
const IN_CHUNK = 80;
/** holdings binds 9 values a row, so a statement carries 9 rows. */
const HOLDINGS_ROWS = 9;
/** Single-row statements per `db.batch`. */
const BATCH_STATEMENTS = 50;
/** close_stale_trades.mjs: "no row" only means "sold" when the chain was read this recently. */
const STALE_TRADE_MS = 36 * 3_600_000;

export interface BalancesSummary {
  /** Traders reached this run, each stamped as attempted; a source left out after REFUSALS_IN_A_ROW was not asked for the later ones. */
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
  /** Tokens Bitquery returned that `tokens` had never seen: inserted minimally (network_id, address, token_key, decimals), the way the .mjs did. */
  readonly unknownTokens: number;
  /** Traders whose aum_live row was marked dirty after their capture; the flush cron revalues them. */
  readonly liveRefreshed: number;
  /** Traders with a wallet this run did not attempt (`wallets.balances_read_at`). Zero means the slice covered the roster. */
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

interface TokenRef { readonly network_id: number; readonly token_key: string }
/** The price rung that answered, and the supply the ceilings need. */
interface Priced { readonly px: number | null; readonly src: string | null; readonly supply: number | null }

const refKey = (networkId: number, tokenKey: string): string => `${networkId}|${tokenKey}`;

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
  const at = new Date().toISOString();
  await sql.unsafe(
    `insert into chain_coverage (handle, network_id, address_key, chain_nonce, rows_held, read_at)
     values ${counted.map(() =>
      "(?,?,?,?,(select count(*) from transactions x where x.address_key = ? and x.network_id = ?),?)").join(",")}
     on conflict (handle, network_id) do update set
       address_key = excluded.address_key, chain_nonce = excluded.chain_nonce,
       rows_held = excluded.rows_held, read_at = excluded.read_at`,
    counted.flatMap((c) => [t.handle, c.network_id, addr, c.nonce, addr, c.network_id, at]),
  );
}

/**
 * The price ladder and the supply for a bounded set of tokens, as the Postgres join did it:
 * pegged_usd FIRST and deliberately (a dollar-pegged asset is a dollar, and neither token_info
 * nor token_prices carries a stablecoin row), then GMGN's price, then the newest daily close.
 * V1c: `src` is the rung that answered (vocabulary positions[].priceSource); a GMGN zero is no price (Z1b).
 */
async function priceTokens(sql: Sql, refs: readonly TokenRef[]): Promise<Map<string, Priced>> {
  const byNetwork = new Map<number, Set<string>>();
  for (const r of refs) {
    const set = byNetwork.get(r.network_id) ?? new Set<string>();
    byNetwork.set(r.network_id, set.add(r.token_key));
  }
  const peg = new Map<string, number>(), info = new Map<string, number>();
  const daily = new Map<string, number>(), supply = new Map<string, number>();
  for (const [net, all] of byNetwork) {
    for (const keys of chunk([...all], IN_CHUNK)) {
      for (const r of await sql<{ token_key: string; pegged_usd: number }[]>`
        select token_key, pegged_usd from quote_assets
         where network_id = ${net} and token_key in (${keys}) and pegged_usd is not null`) {
        peg.set(refKey(net, r.token_key), r.pegged_usd);
      }
      for (const r of await sql<{ token_key: string; price_usd: number }[]>`
        select token_key, price_usd from token_info
         where network_id = ${net} and token_key in (${keys}) and price_usd is not null and price_usd <> 0`) {
        info.set(refKey(net, r.token_key), r.price_usd);
      }
      for (const r of await sql<{ token_key: string; usd: number }[]>`
        select token_key, usd from (
          select token_key, usd, row_number() over (partition by token_key order by day desc) as rn
            from token_prices where network_id = ${net} and token_key in (${keys}) and usd > 0
        ) where rn = 1`) {
        daily.set(refKey(net, r.token_key), r.usd);
      }
      for (const r of await sql<{ token_key: string; total_supply: number | null }[]>`
        select token_key, total_supply from tokens
         where network_id = ${net} and token_key in (${keys}) and total_supply is not null`) {
        if (r.total_supply !== null) supply.set(refKey(net, r.token_key), r.total_supply);
      }
    }
  }
  const out = new Map<string, Priced>();
  for (const r of refs) {
    const k = refKey(r.network_id, r.token_key);
    if (out.has(k)) continue;
    const px = peg.get(k) ?? info.get(k) ?? daily.get(k) ?? null;
    const src = peg.has(k) ? "pegged" : info.has(k) ? "token_info" : daily.has(k) ? "token_prices" : null;
    out.set(k, { px, src, supply: supply.get(k) ?? null });
  }
  return out;
}

/** Run every statement of `make` as one `db.batch`, in slices so no batch grows unbounded. */
async function batched<T>(sql: Sql, items: readonly T[], each: (tx: Sql, item: T) => void): Promise<void> {
  for (const part of chunk(items, BATCH_STATEMENTS)) {
    await sql.begin((tx) => {
      for (const item of part) each(tx, item);
      return Promise.resolve();
    });
  }
}

/** The .mjs write, for one trader's rows. Returns the holdings rows written and the tokens first seen. */
async function writeRows(
  sql: Sql, capturedAt: Date, rows: readonly Row[], learned: ReadonlyMap<string, number>,
): Promise<{ written: number; unknown: number }> {
  if (!rows.length) return { written: 0, unknown: 0 };

  // FK: holdings -> tokens. A mint we have never seen is still a real position. `token_key` is
  // no longer generated, so it is written explicitly (check: token_key = lower(address)).
  const fresh = [...new Map(rows.map((r) => [refKey(r.network_id, r.token_key), r])).values()];
  let unknown = 0;
  for (const part of chunk(fresh, 30)) {
    unknown += (await sql.unsafe(
      `insert into tokens (network_id, address, token_key) values ${part.map(() => "(?,?,?)").join(",")}
       on conflict (network_id, token_key) do nothing`,
      part.flatMap((r) => [r.network_id, r.address, r.token_key]),
    )).count;
  }

  if (learned.size) {
    const decimals = [...learned].map(([k, d]) => {
      const i = k.indexOf(":");
      return { net: Number(k.slice(0, i)), key: k.slice(i + 1), d };
    });
    await batched(sql, decimals, (tx, u) => {
      void tx`update tokens set decimals = ${u.d}
               where network_id = ${u.net} and token_key = ${u.key} and decimals is null`;
    });
  }

  /** Leave NULL where we hold no price; an unpriced position is still written (the portfolio route reports the gap as `pricedShare`). */
  const priced = await priceTokens(sql, rows);
  const at = capturedAt.toISOString();
  const pricedAt = new Date().toISOString();
  // The sampler's value(): the same ceilings, so /positions cannot show a figure a reading
  // would refuse. A refused price stays on the row; only its value is withheld.
  const values = rows.map((r): unknown[] => {
    const p = priced.get(refKey(r.network_id, r.token_key)) ?? { px: null, src: null, supply: null };
    return [
      r.handle, r.network_id, r.token_key, at, Number(r.amount),
      p.px, value(Number(r.amount), p.px, p.supply).usd ?? null, p.src, p.px !== null ? pricedAt : null,
    ];
  });
  await batched(sql, chunk(values, HOLDINGS_ROWS), (tx, part) => {
    void tx.unsafe(
      `insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value, source, price_source, priced_at)
       values ${part.map(() => "(?,?,?,?,?,?,?,'chain',?,?)").join(",")}
       on conflict (handle, network_id, token_key, captured_at) do update
         set human_amount = excluded.human_amount, price = excluded.price,
             value = excluded.value, source = excluded.source,
             price_source = excluded.price_source, priced_at = excluded.priced_at`,
      part.flat(),
    );
  });
  return { written: values.length, unknown };
}

/**
 * Re-price anything we could not value at insert time, scoped to this run's capture
 * (REVIEW_EFFICIENCY_17_SEP item 12). Only rows never valued are touched: a stored price is
 * a measurement, and the same ceilings as value() apply, so a REFUSED price is not re-priced past them.
 */
async function reprice(sql: Sql, capturedAt: Date): Promise<number> {
  const at = capturedAt.toISOString();
  const unvalued = await sql<{ handle: string; network_id: number; token_key: string; human_amount: number }[]>`
    select handle, network_id, token_key, human_amount from holdings
     where source = 'chain' and value is null and human_amount is not null and captured_at = ${at}`;
  if (!unvalued.length) return 0;
  const priced = await priceTokens(sql, unvalued);
  const pricedAt = new Date().toISOString();
  const writes = unvalued.flatMap((r) => {
    const p = priced.get(refKey(r.network_id, r.token_key));
    if (!p || p.px === null || p.px <= 0) return [];
    const usd = value(r.human_amount, p.px, p.supply).usd;
    return usd === undefined ? [] : [{ ...r, px: p.px, src: p.src, usd }];
  });
  await batched(sql, writes, (tx, w) => {
    void tx`update holdings set price = ${w.px}, value = ${w.usd}, price_source = ${w.src}, priced_at = ${pricedAt}
             where handle = ${w.handle} and network_id = ${w.network_id}
               and token_key = ${w.token_key} and captured_at = ${at}`;
  });
  return writes.length;
}

/**
 * close_stale_trades.mjs for the traders just read: an open trade on a (trader, chain) read
 * within 36 h whose token that read did not find is closed by balance. A chain that was not
 * read is never touched: "no row" only means "sold" when the read happened. The `holdings_current`
 * side is read first, bounded by handle, rather than joined per trade.
 */
async function closeStaleTrades(sql: Sql, handles: readonly string[]): Promise<number> {
  const since = new Date(Date.now() - STALE_TRADE_MS).toISOString();
  const held = new Set<string>();
  const open: { trade_id: string; handle: string; network_id: number; token_key: string }[] = [];
  for (const part of chunk([...handles], IN_CHUNK)) {
    for (const r of await sql<{ handle: string; network_id: number; token_key: string }[]>`
      select handle, network_id, token_key from holdings_current
       where handle in (${part}) and human_amount > 0`) {
      held.add(`${r.handle}|${r.network_id}|${r.token_key}`);
    }
    open.push(...await sql<{ trade_id: string; handle: string; network_id: number; token_key: string }[]>`
      select tr.trade_id, tr.handle, tr.network_id, tr.token_key
        from trades tr
       where tr.handle in (${part})
         and tr.status not in ('closed', 'closed_by_balance')
         and exists (select 1 from holdings h
                      where h.handle = tr.handle and h.network_id = tr.network_id
                        and h.source = 'chain' and h.captured_at > ${since})`);
  }
  const stale = open.filter((t) => !held.has(`${t.handle}|${t.network_id}|${t.token_key}`)).map((t) => t.trade_id);
  for (const part of chunk(stale, IN_CHUNK)) {
    await sql`update trades set status = 'closed_by_balance', closed_by = 'balance' where trade_id in (${part})`;
  }
  // fomo closed it itself since; its verdict wins and the balance mark is stale.
  for (const part of chunk([...handles], IN_CHUNK)) {
    await sql`
      update trades set closed_by = null
       where handle in (${part}) and closed_by is not null and status <> 'closed_by_balance'`;
  }
  return stale.length;
}

/**
 * One slice of the stalest traders within `budgetMs`. Throws only when chains were asked and
 * none answered, so the cron shows as failed rather than quietly writing nothing.
 */
export async function runBalances(env: Env, budgetMs: number): Promise<BalancesSummary> {
  const started = Date.now();
  const keys = { helius: (env.HELIUS_SOLANA_KEY ?? "").trim(), bitquery: (env.BITQUERY_KEY ?? "").trim() };
  if (!keys.bitquery) throw new Error("balances: BITQUERY_KEY is not set; EVM chains are read through Bitquery");
  const sql = jobSql(env);
  try {
    const slice = await balanceTargets(sql, sliceSize(env.BALANCE_SLICE));
    const chains = (await sql<{ network_id: number; name: string; rpc: string }[]>`
      select network_id, name, rpc from chains order by network_id`)
      .map((c): Chain => ({ network_id: Number(c.network_id), name: c.name, rpc: c.rpc }));
    const capturedAt = new Date();
    const read: string[] = [];
    let chainsRead = 0, chainsFailed = 0, rowsWritten = 0, unknownTokens = 0, liveRefreshed = 0, stoppedEarly = false;
    let failed: Record<Source, number> = { helius: 0, bitquery: 0 };
    for (const t of slice) {
      if (Date.now() - started > budgetMs) { stoppedEarly = true; break; }
      read.push(t.handle);
      // A source that answered none of REFUSALS_IN_A_ROW traders running is refusing the RUN: its chains are
      // left out (5 tries and ~15 s of backoff each), the other source is still asked, the trader still stamped.
      const ask = askable(t, chains).filter((c) => failed[sourceOf(c)] < REFUSALS_IN_A_ROW);
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
      const next = failedInARow(failed, ask, answers.map((a) => a.status === "fulfilled"));
      for (const s of ["helius", "bitquery"] as const) {
        if (next[s] >= REFUSALS_IN_A_ROW && failed[s] < REFUSALS_IN_A_ROW) {
          console.error(`balances: ${s} answered none of ${next[s]} traders in a row; its chains are left out of the rest of this run`);
        }
      }
      failed = next;
      try {
        // First, and whatever was answered: a refused or emptied wallet writes no row, and unstamped it led every run.
        await stampAttempt(sql, t.handle, capturedAt.toISOString());
        const w = await writeRows(sql, capturedAt, rows, learned);
        rowsWritten += w.written; unknownTokens += w.unknown;
        await writeCoverage(sql, t, counted);
        // The capture is in; mark this trader so the 5-minute flush revalues his live AUM.
        // Mark, do not revalue here: a per-trader revaluation inside the slice was one of the
        // loads that saturated the database on 17 Sep 08:5x UTC.
        // Only when a chain ANSWERED: with Helius refusing every read (19 Sep) this marked 50
        // traders an hour for whom nothing had been learned, and the flush revalued them anyway.
        if (answers.some((a) => a.status === "fulfilled")) {
          await sql`
            insert into aum_live_dirty (handle, marked_at) values (${t.handle}, ${new Date().toISOString()})
            on conflict (handle) do update set marked_at = excluded.marked_at`;
          liveRefreshed += 1;
        }
      } catch (e) {
        console.error(`balances: ${t.handle} write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (chainsRead === 0 && chainsFailed > 0) throw new Error(`balances: all ${chainsFailed} chain reads failed`);

    const repriced = rowsWritten ? await reprice(sql, capturedAt) : 0;
    const tradesClosed = read.length ? await closeStaleTrades(sql, read) : 0;
    const [pending] = await notAttemptedSince(sql, capturedAt.toISOString());
    return {
      traders: read.length, chainsRead, chainsFailed, rowsWritten, unknownTokens, repriced, tradesClosed, liveRefreshed,
      remaining: Number(pending?.n ?? 0), stoppedEarly, elapsedMs: Date.now() - started,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
