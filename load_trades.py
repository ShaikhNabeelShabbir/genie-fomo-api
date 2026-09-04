#!/usr/bin/env python3
"""
Load fomoapi trade history into Postgres.

Kept separate from load_to_db.py on purpose: that script must stay zero-API so a reload
costs nothing. This one spends the fomoapi budget, so it is the script you think twice
before running.

Why this step matters more than its size suggests. `/v1/tokens/:address/activity` (K5-K8)
currently fans out one live fomoapi call per holder, capped at 25, taking ~45 seconds and
covering 25 of 896 rankable tokens. With trades in the database that becomes a SQL query
over all of them — and "has anyone who holds this ever actually sold it", the sharpest
honeypot signal we have, becomes answerable board-wide instead of on a sample.

Budget: one call per trader, ~100 per run, against a 10,000/month free tier.

    100 traders once daily   =  3,000/month   fits
    100 traders twice daily  =  6,000/month   fits
    100 traders every 6h     = 12,000/month   does not

Usage:
    python3 load_trades.py                 # every trader in the database
    python3 load_trades.py --limit 5       # smoke test
    python3 load_trades.py --dry-run
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is not installed — run: python3 -m pip install 'psycopg[binary]>=3.1'")

ROOT = pathlib.Path(__file__).resolve().parent
API = os.environ.get("FOMOAPI_BASE", "https://api.fomoapi.io")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
# MEASURED, not guessed. At fanout 5, three of five traders came back with fomo's
# degraded `{available:false}` envelope even after a retry — a 60% failure rate that looks
# like flakiness and is actually us. At fanout 2, six of six succeeded. fomo serves trades
# live and evidently sheds concurrent load, so this stays low: ~100 traders at 2-wide and
# ~17s a call is roughly 15 minutes, which is fine for a scheduled job and is the
# difference between a complete history and a half-empty one.
FANOUT = int(os.environ.get("FOMO_FANOUT", "2"))


def env(key: str) -> str:
    v = os.environ.get(key, "").strip()
    if v:
        return v
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text().splitlines():
            if line.strip().startswith("#") or "=" not in line:
                continue
            k, val = line.split("=", 1)
            if k.strip() == key:
                return val.strip().strip('"').strip("'")
    return ""


def num(v):
    """A number, or None. Never a coerced zero — see `price` below."""
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return v
    return None


def price(v):
    """
    A price, or None.

    fomo returns `avgEntryPrice: 0` for rows it has no price for. Storing that as a price
    claims someone entered a position for nothing, which then propagates into T3 (return %)
    as a division by zero cost basis. Zero means absent here.
    """
    n = num(v)
    return n if (n is not None and n > 0) else None


def when(v):
    if not isinstance(v, str):
        return None
    try:
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch(handle: str, key: str, limit: int) -> dict:
    """
    One trader's trades, with a single retry on fomo's degraded envelope.

    fomo serves trades live and returns `{available:false, trades:[]}` when its upstream is
    momentarily unwilling — measured at roughly one call in ten, clearing on an immediate
    retry. One retry only: if it degrades twice it is degraded, and we report that rather
    than writing an empty history over a real one.
    """
    url = f"{API}/v2/users/{requests.utils.quote(handle)}/trades?limit={limit}"
    headers = {"authorization": f"Bearer {key}", "Accept": "application/json", "User-Agent": UA}
    for attempt in (1, 2):
        try:
            r = requests.get(url, headers=headers, timeout=90)
        except requests.RequestException as e:
            if attempt == 2:
                return {"handle": handle, "error": str(e)[:120]}
            time.sleep(1.5)
            continue
        if r.status_code == 404:
            return {"handle": handle, "missing": True}
        if not r.ok:
            if attempt == 2:
                return {"handle": handle, "error": f"HTTP {r.status_code}"}
            time.sleep(1.5)
            continue
        doc = r.json()
        if doc.get("available") is False and attempt == 1:
            time.sleep(1.5)
            continue
        doc["handle"] = handle
        return doc
    return {"handle": handle, "error": "unreachable"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="only this many traders (smoke test)")
    ap.add_argument("--all", action="store_true",
                    help="refetch every trader, including ones we already have trades for")
    ap.add_argument("--stale-hours", type=float, default=None,
                    help="with --all, only refetch traders whose newest trade row is older than this")
    ap.add_argument("--trade-limit", type=int, default=500, help="trades per trader")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fanout", type=int, help="override concurrency")
    args = ap.parse_args()

    key = env("FOMOAPI_KEY")
    if not key:
        sys.exit("FOMOAPI_KEY is not set")
    db = env("SUPABASE_DB_URL")
    if not db:
        sys.exit("SUPABASE_DB_URL is not set")

    with psycopg.connect(db) as conn, conn.cursor() as cur:
        # Resumable by default. fomo sheds load over a window, not just per-connection:
        # a 100-trader run at fanout 2 came back with 59 degraded envelopes despite a
        # 6-of-6 success rate on a small sample. Rather than fighting that, the loader
        # only fetches traders it has nothing for, so repeated runs converge on full
        # coverage without re-spending the budget on traders already done.
        if args.all and args.stale_hours is not None:
            cur.execute("""
                select t.handle, t.display_handle from traders t
                where coalesce((select max(x.ingested_at) from trades x where x.handle = t.handle),
                               'epoch'::timestamptz) < now() - make_interval(hours => %s)
                order by t.handle
            """, (args.stale_hours,))
        elif args.all:
            cur.execute("select handle, display_handle from traders order by handle")
        else:
            cur.execute("""
                select t.handle, t.display_handle from traders t
                where not exists (select 1 from trades x where x.handle = t.handle)
                order by t.handle
            """)
        rows = cur.fetchall()
        # token_key -> network_id, so a trade can be attributed to a chain. The trades
        # endpoint carries a token address but NO networkId, so this is the only way.
        cur.execute("select token_key, network_id from tokens")
        net_of = dict(cur.fetchall())

    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        print("every trader already has trades — nothing to fetch (use --all to refresh)")
        return
    scope = "all" if args.all else "missing only"
    print(f"fetching trades for {len(rows)} traders ({scope}, fanout {args.fanout or FANOUT}) …")

    fanout = args.fanout or FANOUT
    docs = []
    with ThreadPoolExecutor(max_workers=fanout) as pool:
        for i, doc in enumerate(pool.map(lambda r: fetch(r[1], key, args.trade_limit), rows), 1):
            docs.append(doc)
            # Progress on one line: a silent 15-minute script cannot be told from a hung one.
            state = ("error" if doc.get("error") else "404" if doc.get("missing")
                     else "degraded" if doc.get("available") is False
                     else f"{len(doc.get('trades') or [])} trades")
            print(f"  [{i:3}/{len(rows)}] {doc.get('handle','?'):<20} {state}", flush=True)

    display_to_handle = {r[1]: r[0] for r in rows}
    trades, symbols = [], {}
    ok = degraded = missing = errored = 0
    unmatched_tokens = set()

    for doc in docs:
        handle = display_to_handle.get(doc.get("handle"), (doc.get("handle") or "").lower())
        if doc.get("error"):
            errored += 1
            continue
        if doc.get("missing"):
            missing += 1
            continue
        if doc.get("available") is False:
            degraded += 1
            continue
        rowset = doc.get("trades") or []
        ok += 1
        captured = when(doc.get("capturedAt")) or dt.datetime.now(dt.timezone.utc)
        for t in rowset:
            tid = t.get("tradeId")
            if not tid:
                continue
            tok = t.get("token") or {}
            addr = (tok.get("address") or "").strip() or None
            tkey = addr.lower() if addr else None
            net = net_of.get(tkey) if tkey else None
            if tkey and net is None:
                unmatched_tokens.add(tkey)
            if tkey and tok.get("symbol") and net is not None:
                symbols[(net, tkey)] = tok["symbol"]
            trades.append((
                tid, handle, net, addr, tkey, tok.get("symbol"), t.get("status"),
                num(t.get("amount")), price(t.get("avgEntryPrice")), price(t.get("avgExitPrice")),
                num(t.get("realizedPnlUsd")), num(t.get("unrealizedPnlUsd")),
                when(t.get("createdAt")), when(t.get("closedAt")), captured,
            ))

    closed = sum(1 for t in trades if t[6] == "closed")
    print(f"  ok {ok} · degraded {degraded} · not found {missing} · errored {errored}")
    print(f"  trades {len(trades)}  ({closed} closed, {len(trades)-closed} open)")
    print(f"  tokens matched to a chain: {len(symbols)} · unmatched: {len(unmatched_tokens)}")
    if args.dry_run:
        print("\ndry run — nothing written")
        return
    if not trades:
        sys.exit("no trades fetched — refusing to write nothing over something")
    if degraded:
        print(f"  note: {degraded} traders degraded; re-run to pick them up "
              f"(the loader skips traders it already has)")

    with psycopg.connect(db) as conn:
        with conn.cursor() as cur:
            cur.executemany("""
                insert into trades (trade_id, handle, network_id, token_address, token_key,
                                    token_symbol, status, amount, avg_entry_price, avg_exit_price,
                                    realized_pnl_usd, unrealized_pnl_usd, opened_at, closed_at, captured_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (trade_id) do update set
                  status = excluded.status, amount = excluded.amount,
                  avg_entry_price = excluded.avg_entry_price, avg_exit_price = excluded.avg_exit_price,
                  realized_pnl_usd = excluded.realized_pnl_usd,
                  unrealized_pnl_usd = excluded.unrealized_pnl_usd,
                  closed_at = excluded.closed_at, captured_at = excluded.captured_at,
                  ingested_at = now()
            """, trades)

            # The holdings feed carries no symbols; trades do. Fill them in without
            # inserting new tokens — a token we do not hold has no networkId we can trust.
            if symbols:
                cur.executemany(
                    "update tokens set symbol = %s where network_id = %s and token_key = %s",
                    [(sym, net, k) for (net, k), sym in symbols.items()],
                )
            cur.execute("select count(*) from trades")
            total = cur.fetchone()[0]
        conn.commit()

    print(f"\nwrote {len(trades)} trades — {total} rows in the table")


if __name__ == "__main__":
    main()
