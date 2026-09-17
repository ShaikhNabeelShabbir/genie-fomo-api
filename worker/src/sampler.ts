import type postgres from "postgres";
import type { Env } from "./env";
import { db } from "./db";
import { SOLANA_NETWORK_ID, solanaBalances } from "../../supabase/functions/_shared/chain_reads.ts";
import { evmBalancesBitquery } from "../../supabase/functions/_shared/bitquery.ts";
import { EVM_CHAINS } from "../../supabase/functions/_shared/settings.ts";
import { concentrationSuspect, decideTotal, value } from "../../supabase/functions/aum-sample/value.ts";

/**
 * AUM sampler, the Worker half. See docs/DECISIONS.md#d188 and docs/CLOUDFLARE_MIGRATION.md §7.
 *
 * TWIN OF `supabase/functions/aum-sample/index.ts`: edit both. The Supabase function stays the
 * source of truth until cutover (§13); this file differs only where Deno does — `env` instead
 * of `Deno.env`, a per-invocation client instead of the module-level one, `sampleSlice()`
 * instead of `Deno.serve`. The chain reads and the valuation rules are imported, not copied.
 */

type Sql = postgres.Sql;

/** Nobody gets to ask for the whole roster in one call. See the header. */
const MAX_SLICE = 25;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json" } });


type Position = { network_id: number; token_key: string; address: string; amount: number };
type Chain = { network_id: number; name: string };
type Trader = { handle: string; sol_address: string | null; evm_address: string | null };
/** One chain's answer: what it held, or why it could not be asked. Never both. `nonce`: the wallet's tx count on an EVM chain that answered (R6). */
type ChainRead = { positions: Position[] | null; reason: string | null; nonce?: number | null };
type Tally = { usd: number; priced: number; total: number };
type Settled = {
  totalUsd: number | null; reason: string | null;
  priced: number; total: number; rejected: number; perChain: Map<number, Tally>;
};

/** Prices (and total supply, for the implied-cap check) for a set of (network, token) pairs, from what this service already holds. See docs/DECISIONS.md#d191 */
async function pricesFor(sql: Sql, pairs: Position[]): Promise<Map<string, { px: number; supply: number | null }>> {
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
async function readChain(keys: { helius: string; bitquery: string }, t: Trader, c: Chain): Promise<ChainRead> {
  const net = Number(c.network_id);
  const pos = (b: { address: string; amount: string }): Position => ({
    network_id: net, token_key: b.address.toLowerCase(), address: b.address, amount: Number(b.amount),
  });
  try {
    if (net === SOLANA_NETWORK_ID) {
      const bals = await solanaBalances(t.sol_address ?? "", keys.helius);
      if (bals === null) return { positions: null, reason: "service_timeout" };
      return { positions: bals.map(pos), reason: null };
    }
    /* Bitquery lists every token held, native included, so an EVM chain is never "no_tokens_known" here (unlike the Supabase twin). */
    const word = EVM_CHAINS[net]?.bitquery;
    if (!word) throw new Error(`no Bitquery network for chain ${net}`);
    const res = await evmBalancesBitquery(keys.bitquery, word, t.evm_address ?? "");
    // ponytail: no nonce on v2 — the public-RPC eth_getTransactionCount is gone and a Bitquery
    // `Transactions(where: {Transaction: {From: {is: $wallet}}}) { count }` (dataset: realtime,
    // https://docs.bitquery.io/docs/evm/transactions/) would double this 5-minute cron's paid
    // calls for a diagnostic. R6 chain_coverage therefore goes stale under v2; add that query
    // in bitquery.ts if R6 is wanted back.
    return { positions: res.balances.map(pos), reason: null, nonce: null };
  } catch (e) {
    console.error(`aum-sample: ${t.handle} ${c.name}: ${(e as Error).message}`);
    return { positions: null, reason: "wallet_unreadable" };
  }
}

const hasWallet = (t: Trader, net: number) =>
  net === SOLANA_NETWORK_ID ? t.sol_address !== null : t.evm_address !== null;

/** Price what the chains answered and decide the parent total. */
async function settle(sql: Sql, reads: Map<number, ChainRead>): Promise<Settled> {
  const perChain = new Map<number, Tally>();
  /** SEED EVERY CHAIN THAT ANSWERED, before counting what came back. See docs/DECISIONS.md#d194 */
  for (const [net, r] of reads) if (r.positions) perChain.set(net, { usd: 0, priced: 0, total: 0 });
  const positions = [...reads.values()].flatMap((r) => r.positions ?? []);
  const px = await pricesFor(sql, positions);
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
  sql: Sql, t: Trader, at: Date, expected: number, reads: Map<number, ChainRead>, s: Settled,
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
      from unnest(${covered.map(([n]) => n)}::bigint[], ${covered.map(([, r]) => r.nonce ?? null)}::bigint[]) as u(n, c)
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

/**
 * One slice: the body of today's `Deno.serve` handler after the auth checks. `body` is the
 * `/sample` request body (`{limit|handle|handles|dryRun}`); the cron passes `{ limit: 10 }`.
 * Returns the report the endpoint answers with; throws on a database fault so a scheduled
 * run shows up as a failed invocation (§7).
 */
export async function sampleSlice(env: Env, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const KEYS = { helius: (env.HELIUS_SOLANA_KEY ?? "").trim(), bitquery: (env.BITQUERY_KEY ?? "").trim() };
  if (!KEYS.bitquery) throw new Error("aum-sample: BITQUERY_KEY is not set; EVM chains are read through Bitquery");
  /**
   * How long one invocation may spend reading chains before it stops and reports.
   *
   * A slice that runs over its budget is killed by the platform mid-write, which is the one
   * outcome worth engineering against: the trader it was working on gets no row and no refusal,
   * so nothing records that he was missed. Stopping early and saying so is strictly better.
   */
  const BUDGET_MS = Number(env.AUM_SAMPLE_BUDGET_MS ?? 100_000);

  const dryRun = body.dryRun === true;
  const one = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : null;
  const named = Array.isArray(body.handles)
    ? body.handles.map((h) => String(h).trim().toLowerCase()).filter(Boolean) : null;
  const asked = Number(body.limit ?? 10);
  const limit = Math.max(1, Math.min(MAX_SLICE, Number.isFinite(asked) ? asked : 10));

  const started = Date.now();
  const sql = db(env);

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

    if (!targets.length) return { sampled: 0, refused: 0, traders: [], note: "no trader matched" };

    const chains = await sql`
      select network_id::bigint, name from chains order by network_id`;

    const handles = targets.map((t) => String(t.handle));

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
      const s = await settle(sql, job.reads);
      entry(job, s);
      if (!dryRun) await write(sql, job.trader, at, job.expected.size, job.reads, s);
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

      /* Known without the wallet that reaches it: expected, not askable; the row says partial. */
      const askable = [...expected].filter((net) => chainById.has(net) && hasWallet(trader, net));
      /* Chains in parallel: the per-host throttle in chain_reads serialises same-host calls, so this is safe. */
      const answers = await Promise.all(askable.map((net) =>
        readChain(KEYS, trader, chainById.get(net)!)));
      const reads = new Map<number, ChainRead>(askable.map((net, i) => [net, answers[i]]));
      const job = { trader, expected, reads };
      await finish(job);
      if ([...reads.values()].some((r) => r.reason === "wallet_unreadable")) retry.push(job);
    }

    /* ONE MORE ASK for every chain that would not answer, after the other traders gave the RPC a rest. */
    for (const job of retry) {
      if (Date.now() - started > BUDGET_MS) { stoppedEarly = true; break; }
      const stale = [...job.reads].filter(([, r]) => r.reason === "wallet_unreadable").map(([net]) => net);
      const again = await Promise.all(stale.map((net) =>
        readChain(KEYS, job.trader, chainById.get(net)!)));
      let flipped = false;
      again.forEach((a, i) => { if (a.positions) { job.reads.set(stale[i], a); flipped = true; } });
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

    return {
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
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** `POST /sample`: the manual door, secret-checked. The cron calls `sampleSlice` directly (§7). */
export async function sample(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.HYPERDRIVE) {
    return json({ error: "not_configured", detail: "HYPERDRIVE binding is parked" }, 503);
  }
  /* No secret set means misconfigured, not open. Refusing is the safe read of that. */
  const SECRET = (env.AUM_SAMPLE_SECRET ?? "").trim();
  if (!SECRET) return json({ error: "AUM_SAMPLE_SECRET is not set; refusing to run" }, 503);
  if ((req.headers.get("x-sample-secret") ?? "") !== SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is a valid default call */ }

  try {
    return json(await sampleSlice(env, body));
  } catch (e) {
    console.error("aum-sample:", (e as Error).message);
    return json({ error: "sampling failed", detail: (e as Error).message }, 500);
  }
}
