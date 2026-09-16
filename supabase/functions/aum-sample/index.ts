import postgres from "https://deno.land/x/postgresjs@v3.4.4/mod.js";
import {
  SOLANA_NETWORK_ID, solanaBalances, evmBalances,
} from "../_shared/chain_reads.ts";
import { concentrationSuspect, value } from "./value.ts";

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

/** Chains the current trader's read actually asked. Reset per trader by readBalances(). */
const attempted = new Set<number>();

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

/** Read every wallet this trader has, on every chain, from the chain itself. See docs/DECISIONS.md#d192 */
async function readBalances(
  t: { handle: string; sol_address: string | null; evm_address: string | null },
  chains: { network_id: number; name: string; rpc: string }[],
  decimals: Map<string, number>,
  tradedByNet: Map<string, { token_key: string; address: string }[]>,
): Promise<Position[]> {
  const out: Position[] = [];

  /*
   * WHICH CHAINS THIS READ ACTUALLY WENT AND ASKED. Recorded on the trader, because the
   * parent row has to say how much of him the reading covered and `perChain` below only
   * knows about chains that came back holding something -- a chain asked and found empty is
   * answered, not missing, and the two must not collapse.
   */
  attempted.clear();

  if (t.sol_address) {
    attempted.add(SOLANA_NETWORK_ID);
    let bals;
    try { bals = await solanaBalances(t.sol_address, HELIUS); }
    catch (e) {
      throw Object.assign(new Error(`solana: ${(e as Error).message}`), { reason: "wallet_unreadable" });
    }
    if (bals === null) throw Object.assign(new Error("no helius key"), { reason: "service_timeout" });
    for (const b of bals) {
      out.push({
        network_id: SOLANA_NETWORK_ID, token_key: b.address.toLowerCase(),
        address: b.address, amount: Number(b.amount),
      });
    }
  }

  if (t.evm_address) {
    for (const c of chains) {
      if (Number(c.network_id) === SOLANA_NETWORK_ID) continue;
      const net = String(c.network_id);
      const tokens = tradedByNet.get(`${t.handle}|${net}`) ?? [];
      if (!tokens.length) continue;
      attempted.add(Number(net));
      const view = {
        get: (k: string) => decimals.get(`${net}:${k}`),
        set: (k: string, v: number) => { decimals.set(`${net}:${k}`, v); },
      };
      let res;
      try { res = await evmBalances(c.rpc, t.evm_address, tokens, view); }
      catch (e) {
        throw Object.assign(new Error(`${c.name}: ${(e as Error).message}`), { reason: "wallet_unreadable" });
      }
      for (const b of res.balances) {
        out.push({
          network_id: Number(net), token_key: b.address.toLowerCase(),
          address: b.address, amount: Number(b.amount),
        });
      }
    }
  }
  return out;
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
          where lower(t.handle) = ${one} or lower(t.display_handle) = ${one}`
      : named
      ? await sql`
          select t.handle, w.sol_address, w.evm_address
          from traders t join wallets w on w.handle = t.handle
          where lower(t.handle) = any(${named}) or lower(t.display_handle) = any(${named})`
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
    const handles = targets.map((t) => String(t.handle));
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
    const tokenKeys = [...new Set(traded.map((r) => String(r.token_key)))];
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

    const report: Record<string, unknown>[] = [];
    let ok = 0, refused = 0, stoppedEarly = false;

    for (const t of targets) {
      if (Date.now() - started > BUDGET_MS) { stoppedEarly = true; break; }

      const trader = {
        handle: String(t.handle),
        sol_address: t.sol_address ? String(t.sol_address) : null,
        evm_address: t.evm_address ? String(t.evm_address) : null,
      };

      let positions: Position[] | null = null;
      let reason: string | null = null;
      let attemptedCount = 0;
      try {
        positions = await readBalances(trader, chains as never, decimals, tradedByNet);
        attemptedCount = attempted.size;
      } catch (e) {
        reason = (e as { reason?: string }).reason ?? "wallet_unreadable";
        positions = null;
      }

      let totalUsd: number | null = null;
      let priced = 0, total = 0, rejected = 0;
      const perChain = new Map<number, { usd: number; priced: number; total: number }>();

      if (positions !== null) {
        /** SEED EVERY CHAIN THIS READ ASKED, before counting what came back. See docs/DECISIONS.md#d194 */
        for (const net of attempted) {
          if (!perChain.has(net)) perChain.set(net, { usd: 0, priced: 0, total: 0 });
        }
        total = positions.length;
        const px = await pricesFor(positions);
        let sum = 0;
        /** The largest priced position, and whether its implied cap could be checked (V1). */
        const top = { usd: 0, capKnown: false };
        for (const p of positions) {
          const c = perChain.get(p.network_id) ?? { usd: 0, priced: 0, total: 0 };
          c.total++;
          const q = px.get(`${p.network_id}:${p.token_key}`);
          const v = value(p.amount, q?.px ?? null, q?.supply ?? null);
          if (v.rejected) rejected++;
          else if (v.usd !== undefined) {
            sum += v.usd; priced++; c.usd += v.usd; c.priced++;
            if (v.usd > top.usd) { top.usd = v.usd; top.capKnown = (q?.supply ?? 0) > 0; }
          }
          perChain.set(p.network_id, c);
        }
        if (priced > 0) {
          /* One coin is most of him and cannot be believed: a price fault, not a balance. */
          if (concentrationSuspect(top.usd, sum, top.capKnown)) reason = "price_suspect";
          else totalUsd = sum;
        } else if (total === 0) {
          /*
           * Every wallet answered and held nothing. The one place a zero is the TRUE value
           * rather than a stand-in for a missing one -- reporting null here would hide a real
           * empty wallet behind "we could not tell". Only reachable because the reads
           * SUCCEEDED; an unreadable wallet threw long before this.
           */
          totalUsd = 0;
        } else {
          /* He holds things and we could price none. A coverage failure, not a zero balance. */
          reason = "no_prices";
        }
      }

      /* Share of his POSITIONS we could value — what makes a thin line legible as thin. */
      const valueShare = total > 0 ? Number((priced / total).toFixed(4)) : null;

      if (totalUsd === null) refused++; else ok++;
      report.push({
        handle: trader.handle,
        totalUsd: totalUsd === null ? null : Number(totalUsd.toFixed(2)),
        refused: totalUsd === null ? (reason ?? "wallet_unreadable") : null,
        pricedPositions: positions === null ? null : priced,
        totalPositions: positions === null ? null : total,
        valueShare,
        ...(rejected ? { priceRejected: rejected } : {}),
      });

      if (dryRun) continue;

      /** HOW MANY OF HIS CHAINS THIS READING COVERED, written onto the parent row. See docs/DECISIONS.md#d195 */
      const chainsExpected = positions === null ? null : attemptedCount;
      /*
       * A chain ANSWERED if it returned — including returning "he holds nothing here".
       * Counting only chains that produced a priced position made an empty wallet look
       * half-read, which is the same fault as the one fixed above, one field along.
       */
      const chainsAnswered = positions === null ? null : perChain.size;

      await sql`
        insert into aum_samples
          (handle, at, total_usd, refused_reason, priced_positions, total_positions,
           value_share, basis, tier, chains_answered, chains_expected)
        values (${trader.handle}, ${at}, ${totalUsd},
                ${totalUsd === null ? (reason ?? "wallet_unreadable") : null},
                ${positions === null ? null : priced},
                ${positions === null ? null : total},
                ${valueShare}, 'sampled',
                ${reason === "price_suspect" ? "reported" : "verified"},
                ${chainsAnswered}, ${chainsExpected})
        on conflict (handle, at, basis) do update set
          total_usd = excluded.total_usd, refused_reason = excluded.refused_reason,
          priced_positions = excluded.priced_positions,
          total_positions = excluded.total_positions,
          value_share = excluded.value_share, tier = excluded.tier,
          chains_answered = excluded.chains_answered,
          chains_expected = excluded.chains_expected,
          sampled_at = now()`;

      if (perChain.size) {
        const nets = [...perChain.keys()];
        await sql`
          insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
          select ${trader.handle}, ${at}, 'sampled', u.n, u.v, u.s, u.r
          from unnest(${nets}::bigint[],
                      ${nets.map((n) => {
                        const c = perChain.get(n)!;
                        /* Held nothing: a true zero, not a gap. Priced something: the sum, unless the reading is a price fault. */
                        if (c.total === 0) return 0;
                        return c.priced > 0 && reason !== "price_suspect" ? c.usd : null;
                      })}::numeric[],
                      ${nets.map((n) => {
                        const c = perChain.get(n)!;
                        /* No positions means nothing to price — a share of nothing is null. */
                        return c.total === 0 ? null : Number((c.priced / c.total).toFixed(4));
                      })}::numeric[],
                      ${nets.map((n) => {
                        const c = perChain.get(n)!;
                        if (c.total === 0) return null;          // read, empty — not a fault
                        if (c.priced === 0) return "no_prices";
                        return reason === "price_suspect" ? "price_suspect" : null;
                      })}::text[]
                     ) as u(n, v, s, r)
          on conflict (handle, at, basis, network_id) do update set
            total_usd = excluded.total_usd, priced_share = excluded.priced_share,
            reason = excluded.reason`;
      }
    }

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
      traders: report,
    });
  } catch (e) {
    console.error("aum-sample:", (e as Error).message);
    return json({ error: "sampling failed", detail: (e as Error).message }, 500);
  }
});
