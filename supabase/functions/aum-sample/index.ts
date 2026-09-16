import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";
import {
  SOLANA_NETWORK_ID, solanaBalances, evmBalances, evmTxCount,
} from "../_shared/chain_reads.ts";
import { concentrationSuspect, decideTotal, value } from "./value.ts";

/** AUM sampler, as a Supabase Edge Function. See docs/DECISIONS.md#d188 */

const url = Deno.env.get("DB_URL") ?? Deno.env.get("SUPABASE_DB_URL") ??
            Deno.env.get("DATABASE_URL") ?? "";
const HELIUS = (Deno.env.get("HELIUS_SOLANA_KEY") ?? "").trim();
/**
 * This function WRITES, so it is not open the way the read API is. The secret is checked on
 * every call; without it set, the function refuses to run at all rather than defaulting open.
 */
const SECRET = (Deno.env.get("AUM_SAMPLE_SECRET") ?? "").trim();

/*
 * max: 1, for the same reason helius-webhook uses it. Edge Functions scale HORIZONTALLY, so
 * every warm instance holds its own pool and `max` multiplies by instance count. The loaders
 * took the read API to 503 by exhausting this pooler on 2026-09-09; a writer that can be
 * invoked on a schedule must not be able to repeat that.
 */
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 15, prepare: false, ssl: "require" });


/**
 * How long one invocation may spend reading chains before it stops and reports.
 *
 * A slice that runs over its budget is killed by the platform mid-write, which is the one
 * outcome worth engineering against: the trader it was working on gets no row and no refusal,
 * so nothing records that he was missed. Stopping early and saying so is strictly better.
 */
const BUDGET_MS = Number(Deno.env.get("AUM_SAMPLE_BUDGET_MS") ?? 100_000);
/** Nobody gets to ask for the whole roster in one call. See the header. */
const MAX_SLICE = 25;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });


type Position = { network_id: number; token_key: string; address: string; amount: number };
type Chain = { network_id: number; name: string; rpc: string };
type Trader = { handle: string; sol_address: string | null; evm_address: string | null };
/** One chain's answer: what it held, or why it could not be asked. Never both. `nonce`: the wallet's tx count on an EVM chain that answered (R6). */
type ChainRead = { positions: Position[] | null; reason: string | null; nonce?: number | null };
type Tally = { usd: number; priced: number; total: number };
type Settled = {
  totalUsd: number | null; reason: string | null;
  priced: number; total: number; rejected: number; perChain: Map<number, Tally>;
};

/** Prices (and total supply, for the implied-cap check) for a set of (network, token) pairs, from what this service already holds. See docs/DECISIONS.md#d191 */
async function pricesFor(pairs: Position[]): Promise<Map<string, { px: number; supply: number | null }>> {
  const m = new Map<string, { px: number; supply: number | null }>();
  if (!pairs.length) return m;
  const rows = await sql`
    select u.n as network_id, u.k as token_key,
           coalesce(qa.pegged_usd, ti.price_usd, tp.usd)::float8 as px,
           tk.total_supply::float8 as supply
    from unnest(${pairs.map((p) => p.network_id)}::bigint[],
                ${pairs.map((p) => p.token_key)}::text[]) as u(n, k)
    left join quote_assets qa on qa.network_id = u.n and qa.token_key = u.k
    left join token_info ti on ti.network_id = u.n and ti.token_key = u.k and ti.price_usd is not null
    left join lateral (
      select usd from token_prices p
      where p.network_id = u.n and p.token_key = u.k order by day desc limit 1
    ) tp on true
    left join tokens tk on tk.network_id = u.n and tk.token_key = u.k`;
  for (const r of rows) {
    if (r.px !== null) {
      m.set(`${r.network_id}:${r.token_key}`,
            { px: Number(r.px), supply: r.supply === null ? null : Number(r.supply) });
    }
  }
  return m;
}

/**
 * Read ONE chain for one trader. Never throws: a chain that will not answer is a reason on
 * its own row, and the other chains still count (Z2, R5). See docs/DECISIONS.md#d192
 */
async function readChain(
  t: Trader, c: Chain, decimals: Map<string, number>,
  tradedByNet: Map<string, { token_key: string; address: string }[]>,
): Promise<ChainRead> {
  const net = Number(c.network_id);
  const pos = (b: { address: string; amount: string }): Position => ({
    network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: Number(b.amount),
  });
  try {
    if (net === SOLANA_NETWORK_ID) {
      const bals = await solanaBalances(t.sol_address ?? "", HELIUS);
      if (bals === null) return { positions: null, reason: "service_timeout" };
      return { positions: bals.map(pos), reason: null };
    }
    const tokens = tradedByNet.get(`${t.handle}|${net}`) ?? [];
    /* Nothing to ask for is unread, not empty (Z1). Lift once evmBalances reads the native balance. */
    if (!tokens.length) return { positions: null, reason: "no_tokens_known" };
    const view = {
      get: (k: string) => decimals.get(`${net}:${k}`),
      set: (k: string, v: number) => { decimals.set(`${net}:${k}`, v); },
    };
    const res = await evmBalances(c.rpc, t.evm_address ?? "", tokens, view);
    return { positions: res.balances.map(pos), reason: null, nonce: await evmTxCount(c.rpc, t.evm_address ?? "") };
  } catch (e) {
    console.error(`aum-sample: ${t.handle} ${c.name}: ${(e as Error).message}`);
    return { positions: null, reason: "wallet_unreadable" };
  }
}

const hasWallet = (t: Trader, net: number) =>
  net === SOLANA_NETWORK_ID ? t.sol_address !== null : t.evm_address !== null;

/** Price what the chains answered and decide the parent total. */
async function settle(reads: Map<number, ChainRead>): Promise<Settled> {
  const perChain = new Map<number, Tally>();
  /** SEED EVERY CHAIN THAT ANSWERED, before counting what came back. See docs/DECISIONS.md#d194 */
  for (const [net, r] of reads) if (r.positions) perChain.set(net, { usd: 0, priced: 0, total: 0 });
  const positions = [...reads.values()].flatMap((r) => r.positions ?? []);
  const px = await pricesFor(positions);
  let sum = 0, priced = 0, rejected = 0;
  /** The largest priced position, and whether its implied cap could be checked (V1). */
  const top = { usd: 0, capKnown: false };
  for (const p of positions) {
    const c = perChain.get(p.network_id)!;
    c.total++;
    const q = px.get(`${p.network_id}:${p.token_key}`);
    const v = value(p.amount, q?.px ?? null, q?.supply ?? null);
    if (v.rejected) rejected++;
    else if (v.usd !== undefined) {
      sum += v.usd; priced++; c.usd += v.usd; c.priced++;
      if (v.usd > top.usd) { top.usd = v.usd; top.capKnown = (q?.supply ?? 0) > 0; }
    }
  }
  const failures = [...reads.values()].flatMap((r) => r.reason ? [r.reason] : []);
  const decided = decideTotal(perChain.size, priced, sum, positions.length, failures);
  /* One coin is most of him and cannot be believed: a price fault, not a balance (V1). */
  const { totalUsd, reason } = decided.totalUsd !== null && concentrationSuspect(top.usd, sum, top.capKnown)
    ? { totalUsd: null, reason: "price_suspect" }
    : decided;
  return { totalUsd, reason, priced, total: positions.length, rejected, perChain };
}

/** The parent row and one row per chain asked, answered or not. See docs/DECISIONS.md#d195 */
async function write(
  t: Trader, at: Date, expected: number, reads: Map<number, ChainRead>, s: Settled,
) {
  const handle = t.handle;
  const answered = s.perChain.size;
  /* R6: the chain's nonce against the rows the indexer holds, per EVM chain that answered. */
  const covered = [...reads].filter(([, r]) => r.nonce != null);
  if (covered.length && t.evm_address) {
    const addr = t.evm_address.toLowerCase();
    await sql`
      insert into chain_coverage (handle, network_id, address_key, chain_nonce, rows_held, read_at)
      select ${handle}, u.n, ${addr}, u.c,
             (select count(*) from transactions x where x.address_key = ${addr} and x.network_id = u.n), now()
      from unnest(${covered.map(([n]) => n)}::bigint[], ${covered.map(([, r]) => r.nonce)}::bigint[]) as u(n, c)
      on conflict (handle, network_id) do update set
        address_key = excluded.address_key, chain_nonce = excluded.chain_nonce,
        rows_held = excluded.rows_held, read_at = excluded.read_at`;
  }
  /* Share of his POSITIONS we could value — what makes a thin line legible as thin. */
  const valueShare = s.total > 0 ? Number((s.priced / s.total).toFixed(4)) : null;
  await sql`
    insert into aum_samples
      (handle, at, total_usd, refused_reason, priced_positions, total_positions,
       value_share, basis, tier, chains_answered, chains_expected)
    values (${handle}, ${at}, ${s.totalUsd}, ${s.totalUsd === null ? s.reason : null},
            ${answered === 0 ? null : s.priced}, ${answered === 0 ? null : s.total},
            ${valueShare}, 'sampled', ${s.reason === "price_suspect" ? "reported" : "verified"}, ${answered}, ${expected})
    on conflict (handle, at, basis) do update set
      total_usd = excluded.total_usd, refused_reason = excluded.refused_reason,
      priced_positions = excluded.priced_positions,
      total_positions = excluded.total_positions,
      value_share = excluded.value_share, tier = excluded.tier,
      chains_answered = excluded.chains_answered,
      chains_expected = excluded.chains_expected,
      sampled_at = now()`;

  if (!reads.size) return;
  const nets = [...reads.keys()];
  const tally = (net: number) => s.perChain.get(net) ?? null;
  await sql`
    insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
    select ${handle}, ${at}, 'sampled', u.n, u.v, u.s, u.r
    from unnest(${nets}::bigint[],
                ${nets.map((n) => {
                  const c = tally(n);
                  /* Not asked: null. Held nothing: a true zero. Priced something: the sum. */
                  if (!c) return null;
                  if (c.total === 0) return 0;
                  return c.priced > 0 && s.reason !== "price_suspect" ? c.usd : null;
                })}::numeric[],
                ${nets.map((n) => {
                  const c = tally(n);
                  return !c || c.total === 0 ? null : Number((c.priced / c.total).toFixed(4));
                })}::numeric[],
                ${nets.map((n) => {
                  const c = tally(n);
                  if (!c) return reads.get(n)!.reason;
                  if (c.total === 0) return null;          // read, empty — not a fault
                  if (c.priced === 0) return "no_prices";
                  return s.reason === "price_suspect" ? "price_suspect" : null;
                })}::text[]
               ) as u(n, v, s, r)
    on conflict (handle, at, basis, network_id) do update set
      total_usd = excluded.total_usd, priced_share = excluded.priced_share,
      reason = excluded.reason`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!url) return json({ error: "no database url configured" }, 500);
  /* No secret set means misconfigured, not open. Refusing is the safe read of that. */
  if (!SECRET) return json({ error: "AUM_SAMPLE_SECRET is not set; refusing to run" }, 503);
  if ((req.headers.get("x-sample-secret") ?? "") !== SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is a valid default call */ }

  const dryRun = body.dryRun === true;
  const one = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : null;
  const named = Array.isArray(body.handles)
    ? body.handles.map((h) => String(h).trim().toLowerCase()).filter(Boolean) : null;
  const asked = Number(body.limit ?? 10);
  const limit = Math.max(1, Math.min(MAX_SLICE, Number.isFinite(asked) ? asked : 10));

  const started = Date.now();

  try {
    /** WHO TO SAMPLE: least-recently-sampled first. See docs/DECISIONS.md#d193 */
    const targets = one
      ? await sql`
          select t.handle, w.sol_address, w.evm_address
          from traders t join wallets w on w.handle = t.handle
          where (w.sol_address is not null or w.evm_address is not null)
            and (lower(t.handle) = ${one} or lower(t.display_handle) = ${one})`
      : named
      ? await sql`
          select t.handle, w.sol_address, w.evm_address
          from traders t join wallets w on w.handle = t.handle
          where (w.sol_address is not null or w.evm_address is not null)
            and (lower(t.handle) = any(${named}) or lower(t.display_handle) = any(${named}))`
      : await sql`
          select t.handle, w.sol_address, w.evm_address
          from traders t
          join wallets w on w.handle = t.handle
          left join lateral (
            select max(at) as last_at from aum_samples s
            where s.handle = t.handle and s.basis = 'sampled') s on true
          where w.sol_address is not null or w.evm_address is not null
          order by s.last_at asc nulls first, t.handle
          limit ${limit}`;

    if (!targets.length) return json({ sampled: 0, refused: 0, traders: [], note: "no trader matched" });

    const chains = await sql`
      select network_id::bigint, name, rpc from chains order by network_id`;

    /*
     * Decimals and traded-token lists, scoped to THIS SLICE.
     *
     * The Node job loads all 20,654 tokens once because it then works through 441 traders. A
     * slice of ten does not earn that: scoping both queries to the handles in hand keeps an
     * invocation's database cost proportional to the work it was asked to do.
     */
    const handles = targets.map((t: Record<string, unknown>) => String(t.handle));
    const traded = await sql`
      select handle, network_id::bigint, token_key, min(token_address) as address
      from trades
      where handle = any(${handles}) and network_id <> ${SOLANA_NETWORK_ID}
        and token_address is not null
      group by 1, 2, 3`;
    const tradedByNet = new Map<string, { token_key: string; address: string }[]>();
    for (const r of traded) {
      const k = `${r.handle}|${r.network_id}`;
      const a = tradedByNet.get(k) ?? [];
      a.push({ token_key: String(r.token_key), address: String(r.address) });
      tradedByNet.set(k, a);
    }
    const tokenKeys = [...new Set(traded.map((r: Record<string, unknown>) => String(r.token_key)))];
    const decimals = new Map<string, number>();
    if (tokenKeys.length) {
      for (const r of await sql`
        select network_id::bigint, token_key, decimals from tokens
        where token_key = any(${tokenKeys}) and decimals is not null`) {
        decimals.set(`${r.network_id}:${r.token_key}`, Number(r.decimals));
      }
    }

    /*
     * The hour this sample describes. Truncated so a run at :07 and one at :52 do not produce
     * two points for the same hour that a chart would draw as a spike. Same rule as the Node
     * job, and the primary key (handle, at, basis) makes a repeat run an update rather than a
     * second point.
     */
    const at = new Date();
    at.setUTCMinutes(0, 0, 0);

    /*
     * EXPECTED CHAINS ARE THE ONES /aum PUBLISHES: presence ∪ holdings ∪ chain samples.
     * Twin of the `trader_chain_history` view (migration 20260917230000); change both.
     */
    const knownByHandle = new Map<string, Set<number>>();
    for (const r of await sql`
      select s.handle, s.network_id::bigint
      from (select handle, network_id from wallet_chain_presence where handle = any(${handles})
            union select handle, network_id from holdings_current
                  where handle = any(${handles}) and human_amount > 0
            union select handle, network_id from aum_chain_samples
                  where handle = any(${handles}) and total_usd is not null) s
      join chains using (network_id)`) {
      const h = String(r.handle);
      knownByHandle.set(h, (knownByHandle.get(h) ?? new Set<number>()).add(Number(r.network_id)));
    }
    const chainById = new Map<number, Chain>(
      (chains as unknown as Chain[]).map((c) => [Number(c.network_id), c]));

    const report = new Map<string, Record<string, unknown>>();
    let stoppedEarly = false;
    type Job = { trader: Trader; expected: Set<number>; reads: Map<number, ChainRead> };
    const retry: Job[] = [];

    const entry = (job: Job, s: Settled) => {
      const failed: Record<string, string> = {};
      for (const [net, r] of job.reads) if (r.reason) failed[chainById.get(net)?.name ?? String(net)] = r.reason;
      report.set(job.trader.handle, {
        handle: job.trader.handle,
        totalUsd: s.totalUsd === null ? null : Number(s.totalUsd.toFixed(2)),
        refused: s.totalUsd === null ? s.reason : null,
        pricedPositions: s.perChain.size === 0 ? null : s.priced,
        totalPositions: s.perChain.size === 0 ? null : s.total,
        valueShare: s.total > 0 ? Number((s.priced / s.total).toFixed(4)) : null,
        chains: { answered: s.perChain.size, expected: job.expected.size, failed },
        ...(s.rejected ? { priceRejected: s.rejected } : {}),
      });
    };
    const finish = async (job: Job) => {
      const s = await settle(job.reads);
      entry(job, s);
      if (!dryRun) await write(job.trader, at, job.expected.size, job.reads, s);
    };

    for (const t of targets) {
      if (Date.now() - started > BUDGET_MS) { stoppedEarly = true; break; }

      const trader: Trader = {
        handle: String(t.handle),
        sol_address: t.sol_address ? String(t.sol_address) : null,
        evm_address: t.evm_address ? String(t.evm_address) : null,
      };
      /* Solana lists everything held, so it is always asked when he has that wallet. */
      const expected = new Set(knownByHandle.get(trader.handle) ?? []);
      if (trader.sol_address) expected.add(SOLANA_NETWORK_ID);

      const reads = new Map<number, ChainRead>();
      for (const net of expected) {
        const c = chainById.get(net);
        /* Known without the wallet that reaches it: expected, not askable; the row says partial. */
        if (!c || !hasWallet(trader, net)) continue;
        reads.set(net, await readChain(trader, c, decimals, tradedByNet));
      }
      const job = { trader, expected, reads };
      await finish(job);
      if ([...reads.values()].some((r) => r.reason === "wallet_unreadable")) retry.push(job);
    }

    /* ONE MORE ASK for every chain that would not answer, after the other traders gave the RPC a rest. */
    for (const job of retry) {
      if (Date.now() - started > BUDGET_MS) { stoppedEarly = true; break; }
      let flipped = false;
      for (const [net, r] of job.reads) {
        if (r.reason !== "wallet_unreadable") continue;
        const again = await readChain(job.trader, chainById.get(net)!, decimals, tradedByNet);
        if (again.positions) { job.reads.set(net, again); flipped = true; }
      }
      if (flipped) await finish(job);
    }
    const ok = [...report.values()].filter((e) => e.totalUsd !== null).length;
    const refused = report.size - ok;

    /** How much of the roster is still waiting, so a scheduler can pace itself. */
    const [pending] = await sql`
      select count(*)::int as n from traders t
      join wallets w on w.handle = t.handle
      left join lateral (
        select max(at) as last_at from aum_samples s
        where s.handle = t.handle and s.basis = 'sampled') s on true
      where (w.sol_address is not null or w.evm_address is not null)
        and (s.last_at is null or s.last_at < ${at})`;

    return json({
      at: at.toISOString(),
      dryRun,
      sampled: ok,
      refused,
      elapsedMs: Date.now() - started,
      /** True when the time budget ended the run before the slice did. Not an error. */
      stoppedEarly,
      /** Traders with no reading for this hour yet. Zero means the roster is current. */
      pendingThisHour: Number(pending?.n ?? 0),
      traders: [...report.values()],
    });
  } catch (e) {
    console.error("aum-sample:", (e as Error).message);
    return json({ error: "sampling failed", detail: (e as Error).message }, 500);
  }
});
