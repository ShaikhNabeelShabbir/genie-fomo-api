#!/usr/bin/env node
/**
 * TO-DO-BEFORE-MIGRATION item 10 — reconcile fomo's open trades against chain balances.
 *
 * /pnl counted trades with status <> 'closed'; /positions lists holdings_current. Nothing
 * reconciled them, so a trade fomo never closed stayed "open" for months after the wallet
 * sold. This marks such a trade `status = 'closed_by_balance', closed_by = 'balance'` when
 * the wallet no longer holds the token on a chain WE READ within 36 h. A chain that was not
 * read is never touched: "no row" only means "sold" when the read happened.
 *
 * Runs after load_chain_balances.mjs. Idempotent: load_trades.py rewrites `status` from fomo
 * every night, and this pass re-applies the balance verdict on top.
 *
 *   node scripts/close_stale_trades.mjs             # close
 *   node scripts/close_stale_trades.mjs --dry-run   # counts only
 */
import pg from "pg";

const DB = (process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? "").trim();
if (!DB) { console.error("DATABASE_URL is not set"); process.exit(1); }
const DRY = process.argv.includes("--dry-run");

const pool = new pg.Pool({ connectionString: DB, ssl: { rejectUnauthorized: false }, max: 2 });

// Open trades on a (trader, chain) read within 36 h whose token that read did not find.
const STALE = `
  select tr.trade_id
  from trades tr
  where tr.status not in ('closed', 'closed_by_balance')
    and exists (select 1 from holdings h
                where h.handle = tr.handle and h.network_id = tr.network_id
                  and h.source = 'chain' and h.captured_at > now() - interval '36 hours')
    and not exists (select 1 from holdings_current hc
                    where hc.handle = tr.handle and hc.network_id = tr.network_id
                      and hc.token_key = tr.token_key and hc.human_amount > 0)`;

async function main() {
  const { rows: [c] } = await pool.query(`
    select count(*) filter (where status not in ('closed', 'closed_by_balance'))::int as open,
           count(*) filter (where status = 'closed_by_balance')::int as already,
           (select count(*) from (${STALE}) s)::int as stale
    from trades`);
  console.log(`${c.open} open trades · ${c.already} already closed_by_balance · ` +
              `${c.stale} to close${DRY ? "  [DRY RUN]" : ""}`);
  if (!DRY) {
    const { rowCount } = await pool.query(`
      update trades set status = 'closed_by_balance', closed_by = 'balance'
      where trade_id in (${STALE})`);
    // fomo closed it itself since; its verdict wins and the balance mark is stale.
    const { rowCount: cleared } = await pool.query(`
      update trades set closed_by = null
      where closed_by is not null and status <> 'closed_by_balance'`);
    console.log(`closed ${rowCount} by balance · cleared closed_by on ${cleared} fomo-closed trades`);
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
