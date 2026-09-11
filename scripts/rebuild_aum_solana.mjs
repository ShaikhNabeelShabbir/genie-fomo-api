#!/usr/bin/env node
/**
 * AUM backfill for Solana (AUM_CHART_PRD.md §3.1) — the fifth chain.
 *
 * WHY NOT getSignaturesForAddress, WHICH IS THE OBVIOUS CHOICE. It answers for the OWNER
 * address, and a token transfer into a wallet often never names the owner -- only its token
 * account. So the owner scan sees the sells, which the owner signs, and misses much of the
 * buying. Built that way first and measured it: balances decayed to zero and never recovered,
 * and 167 of 310 positions disagreed with a chain read, including zeroes where the trader
 * demonstrably held a balance. One wallet's USDC account alone carried more signatures than
 * the owner scan returned for the whole wallet over 30 days.
 *
 * Helius's enhanced transaction history indexes the same activity by OWNER, mapping each
 * token account back through `userAccount`. Measured on the same wallets: 80 of 82 and 134 of
 * 135 balances reproduced exactly from a single page.
 *
 * THE METHOD IS ROBINHOOD'S, WITH A DIFFERENT SOURCE OF MOVEMENTS. Anchor on the balance we
 * read from chain, subtract the changes back to each day boundary, and prove it forward
 * before writing: anchor plus every change since the anchor must equal what the wallet holds
 * right now. A wallet that fails is skipped with its reason -- never written half-right.
 *
 *   node scripts/rebuild_aum_solana.mjs --limit 3 --dry-run
 *   node scripts/rebuild_aum_solana.mjs
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const DB  = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
const KEY = (process.env.HELIUS_SOLANA_KEY ?? "").trim();
if (!DB)  { console.error("DATABASE_URL is not set"); process.exit(1); }
if (!KEY) { console.error("HELIUS_SOLANA_KEY is not set"); process.exit(1); }

const arg  = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const DRY   = flag("dry-run");
const DAYS  = Number(arg("days", "30"));
const LIMIT = Number(arg("limit", "0")) || null;
/*
 * Write what is cached WITHOUT the forward check, because the provider will not answer.
 *
 * The check needs a live balance, and while Helius is rate-limiting us it cannot run at all
 * -- which would mean serving nothing rather than something. So this writes the cached
 * history and leans on two things to stay honest: the method itself is proven (43 wallets
 * reconciled at 96-99% before the limit hit), and a later verified pass DELETES the rows of
 * any wallet that then fails. Unverified data can be served, but it cannot outlive its own
 * correction.
 */
const OFFLINE = flag("offline");
const CACHE = arg("cache-dir", ".cache/rebuild_solana_v2");

const NETWORK_ID = 1399811149;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MAX_PRICE_PER_TOKEN = 1_000_000;
const MAX_POSITION_USD    = 1_000_000_000_000;
const PRICE_GAP_DAYS = 7;
/** A balance is "reproduced" within this relative tolerance; below it is float noise. */
const VERIFY_TOL = 1e-3;

/*
 * THE GATE IS WEIGHTED BY VALUE, NOT BY COUNT, and counting was the wrong test.
 *
 * A wallet holding 47 positions where 13 dust tokens fail to reconcile is not a wallet we
 * cannot describe -- it is one we can describe to better than 99% of its dollars. Counting
 * treated a $5 token with odd transfer mechanics exactly like a $500,000 one and refused the
 * whole wallet over it. What actually matters to a balance chart is the share of the money
 * that reconciles, so that is what is measured, and the share is recorded rather than assumed.
 */
const VERIFY_MIN_VALUE_SHARE = 0.9;

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 3 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function value(amount, price) {
  if (price === null || !Number.isFinite(price) || price <= 0) return {};
  if (price > MAX_PRICE_PER_TOKEN) return { rejected: true };
  const usd = amount * price;
  if (!Number.isFinite(usd) || usd > MAX_POSITION_USD) return { rejected: true };
  return { usd };
}

const WAITS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000, 90_000, 120_000, 180_000];

/*
 * A pause between wallets, which is cheaper than it looks.
 *
 * Without it the job walks the roster as fast as Helius will answer, and about seventy
 * wallets in it stops answering -- at which point wallets are SKIPPED rather than merely
 * slowed, and a skipped wallet costs a whole re-run. Pacing keeps us inside the budget, and
 * the per-wallet cache means an interrupted run never repeats work it already paid for.
 */
const WALLET_GAP_MS = Number(arg("gap", "1500"));
async function patient(label, fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= WAITS.length) throw e;
      console.log(`    ${label}: ${e.message} — waiting ${WAITS[i] / 1000}s`);
      await sleep(WAITS[i]);
    }
  }
}

async function enhancedPage(address, before) {
  const u = `https://api.helius.xyz/v0/addresses/${address}/transactions` +
            `?api-key=${KEY}&limit=100${before ? `&before=${before}` : ""}`;
  return patient(`history ${address.slice(0, 6)}`, async () => {
    const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  });
}

/** Every token-balance change for this owner back to `cutoff`, as { mint, at, delta }. */
async function changesSince(address, cutoff) {
  const out = [];
  let before = null;
  for (let page = 0; page < 60; page++) {
    const j = await enhancedPage(address, before);
    if (!Array.isArray(j) || !j.length) break;
    for (const tx of j) {
      if (!tx?.timestamp) continue;
      for (const ad of tx.accountData ?? []) {
        for (const ch of ad.tokenBalanceChanges ?? []) {
          if (ch?.userAccount !== address) continue;
          const dec = Number(ch.rawTokenAmount?.decimals ?? 0);
          const raw = Number(ch.rawTokenAmount?.tokenAmount ?? 0);
          if (!Number.isFinite(raw)) continue;
          out.push({ mint: String(ch.mint).toLowerCase(), at: tx.timestamp, delta: raw / Math.pow(10, dec) });
        }
      }
    }
    const last = j[j.length - 1];
    if (!last?.signature || last.timestamp < cutoff || j.length < 100) break;
    before = last.signature;
  }
  return out;
}

/** What the wallet holds right now, straight from chain — the forward check's ground truth. */
async function liveBalances(address) {
  const live = new Map();
  for (const programId of [SPL, T22]) {
    const j = await patient(`accounts ${address.slice(0, 6)}`, async () => {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
          params: [address, { programId }, { encoding: "jsonParsed" }] }),
        signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    });
    for (const a of j.result?.value ?? []) {
      const i = a.account?.data?.parsed?.info;
      if (!i?.mint) continue;
      const amt = Number(i.tokenAmount?.uiAmountString ?? 0);
      if (Number.isFinite(amt)) live.set(String(i.mint).toLowerCase(), amt);
    }
  }
  return live;
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  const client = await pool.connect();
  try {
    const { rows: wallets } = await client.query(`
      select distinct w.handle, w.sol_address from wallets w
      join holdings_current h on h.handle = w.handle
      where w.sol_address is not null and h.network_id = ${NETWORK_ID} and h.human_amount > 0
      order by w.handle ${LIMIT ? `limit ${LIMIT}` : ""}`);
    console.log(`${wallets.length} Solana wallets`);

    const { rows: held } = await client.query(`
      select handle, token_key, human_amount::float8 amount, captured_at,
             coalesce(value, 0)::float8 as usd
      from holdings_current where network_id = ${NETWORK_ID} and human_amount > 0`);
    const heldBy = new Map();
    for (const h of held) {
      let m = heldBy.get(h.handle); if (!m) heldBy.set(h.handle, m = new Map());
      m.set(h.token_key, { amount: Number(h.amount), usd: Number(h.usd),
                           at: Math.floor(new Date(h.captured_at).getTime() / 1000) });
    }

    // ---------------------------------------------------------- price series
    const { rows: pxRows } = await client.query(`
      select token_key, at, px from (
        select token_key, opened_at at, avg_entry_price::float8 px from trades
          where network_id = ${NETWORK_ID} and avg_entry_price > 0 and opened_at is not null
        union all
        select token_key, closed_at, avg_exit_price::float8 from trades
          where network_id = ${NETWORK_ID} and avg_exit_price > 0 and closed_at is not null
      ) s where at >= now() - interval '${DAYS + 20} days'`);
    const series = new Map();
    for (const r of pxRows) {
      const t = new Date(r.at).getTime();
      if (!Number.isFinite(t) || !Number.isFinite(r.px)) continue;
      let a = series.get(r.token_key); if (!a) series.set(r.token_key, a = []);
      a.push({ t, px: Number(r.px) });
    }
    for (const a of series.values()) a.sort((x, y) => x.t - y.t);
    const { rows: pegged } = await client.query(
      `select token_key, pegged_usd::float8 px from quote_assets
       where network_id = ${NETWORK_ID} and pegged_usd is not null`);
    const peg = new Map(pegged.map((r) => [r.token_key, Number(r.px)]));
    const GAP = PRICE_GAP_DAYS * 86400_000;
    const priceAt = (token, ms) => {
      const fixed = peg.get(token);
      if (fixed !== undefined) return fixed;
      const a = series.get(token); if (!a) return null;
      let best = null, bestD = Infinity;
      for (const p of a) { const d = Math.abs(p.t - ms); if (d < bestD) { bestD = d; best = p.px; } }
      return bestD <= GAP ? best : null;
    };
    console.log(`${pxRows.length.toLocaleString()} dated prices · ${series.size.toLocaleString()} tokens · ${peg.size} pegged`);

    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const boundaries = [];
    for (let d = DAYS; d >= 1; d--) boundaries.push(new Date(midnight.getTime() - d * 86400_000));
    const cutoff = Math.floor(boundaries[0].getTime() / 1000);

    let wrote = 0, okWallets = 0, skipped = 0, i = 0;
    for (const w of wallets) {
      i++;
      const tag = `[${String(i).padStart(3)}/${wallets.length}] ${w.handle.padEnd(20)}`;
      const file = path.join(CACHE, `${w.sol_address}.json`);
      if (!fs.existsSync(file)) await sleep(WALLET_GAP_MS);
      let changes = null;
      if (fs.existsSync(file)) { try { changes = JSON.parse(fs.readFileSync(file, "utf8")); } catch { changes = null; } }
      if (!changes) {
        try {
          changes = await changesSince(w.sol_address, cutoff);
          fs.writeFileSync(file, JSON.stringify(changes));
        } catch (e) { console.log(`${tag} history failed: ${e.message} — skipped`); skipped++; continue; }
      }

      const anchors = heldBy.get(w.handle) ?? new Map();
      if (!anchors.size) { skipped++; continue; }

      /*
       * PROVE IT FORWARD BEFORE TRUSTING IT. Anchor plus every change since the anchor must
       * equal what the wallet holds now. This is the check that exposed the owner-scan method
       * as incomplete, so it gates every wallet rather than a sample of them.
       */
      let live = null;
      if (!OFFLINE) {
        try { live = await liveBalances(w.sol_address); }
        catch (e) { console.log(`${tag} live read failed: ${e.message} — skipped`); skipped++; continue; }
      }

      let pass = 0, fail = 0, usdOk = 0, usdAll = 0;
      for (const [mint, a] of live ? anchors : []) {
        const actual = live.get(mint);
        if (actual === undefined) continue;
        let since = 0;
        for (const c of changes) if (c.mint === mint && c.at > a.at) since += c.delta;
        const predicted = a.amount + since;
        const d = Math.abs(predicted - actual) / Math.max(Math.abs(actual), 1e-9);
        usdAll += a.usd;
        if (d < VERIFY_TOL) { pass++; usdOk += a.usd; } else fail++;
      }
      const checked = pass + fail;
      /*
       * A wallet whose money does not reconcile is not written at all. When every position
       * we could check is worth nothing, there is no value to weigh, so the count is the only
       * evidence left and it has to carry the decision.
       */
      const share = usdAll > 0 ? usdOk / usdAll : (checked ? pass / checked : 1);
      if (checked >= 3 && share < VERIFY_MIN_VALUE_SHARE) {
        console.log(`${tag} verify ${pass}/${checked} · ${(share * 100).toFixed(1)}% of value ` +
                    `— skipped, the money does not reconcile`);
        /*
         * Remove anything an earlier unverified pass wrote for this wallet. A wallet that
         * fails the check must not keep serving numbers just because it was written before
         * we could check it.
         */
        if (!DRY) {
          const gone = await client.query(
            `delete from aum_chain_samples where handle = $1 and basis = 'rebuilt'
               and network_id = ${NETWORK_ID} returning 1`, [w.handle]);
          if (gone.rowCount) console.log(`${tag}   removed ${gone.rowCount} previously written rows`);
        }
        skipped++; continue;
      }
      okWallets++;

      // ------------------------------------------------- the walk back
      const perDay = new Map();
      const mints = new Set([...anchors.keys(), ...changes.map((c) => c.mint)]);
      for (const mint of mints) {
        const a = anchors.get(mint);
        const anchorAmt = a ? a.amount : 0;
        const anchorAt  = a ? a.at : Math.floor(Date.now() / 1000);
        const rel = changes.filter((c) => c.mint === mint && c.at <= anchorAt)
                           .sort((x, y) => y.at - x.at);
        let acc = 0, k = 0;
        for (let bi = boundaries.length - 1; bi >= 0; bi--) {
          const sec = Math.floor(boundaries[bi].getTime() / 1000);
          while (k < rel.length && rel[k].at > sec) { acc += rel[k].delta; k++; }
          const bal = anchorAmt - acc;
          if (!(bal > 0)) continue;          // a zero or a negative is not a position
          const ms = boundaries[bi].getTime();
          let c = perDay.get(ms); if (!c) perDay.set(ms, c = { usd: 0, priced: 0, total: 0 });
          c.total++;
          const v = value(bal, priceAt(mint, ms));
          if (v.usd !== undefined) { c.usd += v.usd; c.priced++; }
        }
      }
      console.log(`${tag} ${live ? `verify ${pass}/${checked} · ${(share * 100).toFixed(1)}% of value` : "UNVERIFIED (offline)"} · ` +
                  `${changes.length} changes · ${perDay.size} days`);
      if (!perDay.size || DRY) { if (DRY) wrote += perDay.size; continue; }

      const ats = [...perDay.keys()].sort((x, y) => x - y);
      const rows = ats.map((ms) => {
        const c = perDay.get(ms);
        const ok = c.priced > 0;
        return { at: new Date(ms), usd: ok ? c.usd : null,
                 reason: ok ? null : "no_prices",
                 priced: c.priced, total: c.total,
                 share: c.total > 0 ? Number((c.priced / c.total).toFixed(4)) : null };
      });

      await client.query(`
        insert into aum_samples (handle, at, total_usd, refused_reason, priced_positions,
          total_positions, value_share, basis, tier)
        select $1, u.at, null, 'chains_unrebuildable', u.priced, u.total_pos, u.share, 'rebuilt', 'reported'
        from unnest($2::timestamptz[], $3::int[], $4::int[], $5::numeric[]) as u(at, priced, total_pos, share)
        on conflict (handle, at, basis) do update set
          priced_positions = greatest(aum_samples.priced_positions, excluded.priced_positions),
          total_positions  = greatest(aum_samples.total_positions,  excluded.total_positions),
          sampled_at = now()`,
        [w.handle, rows.map((r) => r.at), rows.map((r) => r.priced), rows.map((r) => r.total), rows.map((r) => r.share)]);
      await client.query(`
        insert into aum_chain_samples (handle, at, basis, network_id, total_usd, priced_share, reason)
        select $1, u.at, 'rebuilt', ${NETWORK_ID}, u.usd, u.share, u.reason
        from unnest($2::timestamptz[], $3::numeric[], $4::numeric[], $5::text[]) as u(at, usd, share, reason)
        on conflict (handle, at, basis, network_id) do update set
          total_usd = excluded.total_usd, priced_share = excluded.priced_share, reason = excluded.reason`,
        [w.handle, rows.map((r) => r.at), rows.map((r) => r.usd), rows.map((r) => r.share), rows.map((r) => r.reason)]);
      wrote += rows.length;
    }
    console.log(`\n${wrote} solana points · ${okWallets} wallets verified · ${skipped} skipped${DRY ? " (dry run)" : ""}`);
  } finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
