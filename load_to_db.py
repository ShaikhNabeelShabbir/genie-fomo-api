#!/usr/bin/env python3
"""
Load a directory build into Postgres.

Deliberately SEPARATE from build_directory_fomoapi.py. The builder fetches and validates;
this only writes. Three things follow from that split:

  * A reload costs zero API calls. The file on disk is replayable indefinitely, so schema
    work and the plan's step 3.2 checkpoint never touch fomoapi.
  * A database failure cannot lose a build. The file is written and validated first.
  * The file survives as an independent copy to diff the database against — which is the
    entire point of the checkpoint.

Ingestion is APPEND-ONLY. `captured_at` comes from the build's own `generated_at` and is
part of the primary key on holdings and trader_stats, so each run adds a generation rather
than replacing one. Re-running the same file is idempotent: same captured_at, same rows,
ON CONFLICT updates in place.

Usage:
    python3 load_to_db.py                      # data/wallet.full.data.json
    python3 load_to_db.py --in some/other.json
    python3 load_to_db.py --dry-run            # parse and report, write nothing
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import sys

try:
    import psycopg
except ImportError:
    sys.exit("psycopg is not installed — run: python3 -m pip install 'psycopg[binary]>=3.1'")

ROOT = pathlib.Path(__file__).resolve().parent
KNOWN_NETWORKS = {1, 56, 4663, 8453, 1399811149}


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def db_url() -> str:
    """SUPABASE_DB_URL from the environment, falling back to .env."""
    url = os.environ.get("SUPABASE_DB_URL", "").strip()
    if url:
        return url
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == "SUPABASE_DB_URL":
                return v.strip().strip('"').strip("'")
    die("SUPABASE_DB_URL is not set (env or .env)")
    return ""


def num(v):
    """
    A number, or None.

    Nothing here coerces a missing value to 0. `holdings.value` is nullable with no default
    precisely so that 1,710 unpriced rows stay excluded from every aggregate — writing 0
    would make them look priced and silently change T13, T14, K3 and C2.
    """
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)) and math.isfinite(v):
        return v
    return None


def load(path: pathlib.Path) -> dict:
    if not path.exists():
        die(f"{path} does not exist — run build_directory_fomoapi.py first")
    doc = json.loads(path.read_text())
    traders = doc.get("traders")
    if not isinstance(traders, list) or not traders:
        die(f"{path} carries no traders")
    gen = doc.get("generated_at")
    if not isinstance(gen, int):
        die("build has no integer generated_at — cannot derive captured_at")
    return doc


def shape(doc: dict):
    """Turn the build document into the rows each table wants, deduped and validated."""
    captured = dt.datetime.fromtimestamp(doc["generated_at"], dt.timezone.utc)

    traders, stats = [], []
    wallets: dict[str, list] = {}
    tokens: dict[tuple[int, str], str] = {}
    holdings: dict[tuple[str, int, str], tuple] = {}
    skipped = 0

    for t in doc["traders"]:
        raw_handle = (t.get("handle") or "").strip()
        if not raw_handle:
            skipped += 1
            continue
        handle = raw_handle.lower()

        traders.append((handle, raw_handle, t.get("name"), t.get("avatar"),
                        t.get("bio"), t.get("twitter"), bool(t.get("verified")),
                        t.get("src") or "fomoapi.io"))
        stats.append((handle, captured, t.get("rank"), num(t.get("pnl")),
                      num(t.get("volume")), t.get("trades"), t.get("followers")))

        # fomo's own evm/sol fields are empty for all 100 traders; src_evm/src_sol are
        # fomoapi's resolution and were live when sampled. Provenance is recorded per
        # chain so a consumer can tell Reported from Verified — these are REPORTED.
        evm = (t.get("src_evm") or "").strip() or None
        sol = (t.get("src_sol") or "").strip() or None
        if evm or sol:
            src = t.get("src") or "fomoapi.io"
            wallets[handle] = [handle, evm, src if evm else None, sol, src if sol else None]

        for h in t.get("holdings") or []:
            addr = (h.get("tokenAddress") or "").strip()
            net = h.get("networkId")
            if not addr or not isinstance(net, int):
                skipped += 1
                continue
            if net not in KNOWN_NETWORKS:
                # A chain we have no row for would fail the FK anyway; say so loudly
                # rather than dropping positions on the floor.
                die(f"unknown networkId {net} on {handle} — seed it in `chains` first")
            key = addr.lower()
            # Case is preserved on first sight: Solana base58 is case-SENSITIVE and an
            # address we lowercase is an address we can no longer query.
            tokens.setdefault((net, key), addr)
            # Last write wins within a build; the file has no duplicates today, but a
            # future one having them must not blow up ON CONFLICT.
            holdings[(handle, net, key)] = (
                handle, net, key, captured,
                num(h.get("humanAmount")), num(h.get("price")), num(h.get("value")),
            )

    return captured, traders, stats, list(wallets.values()), tokens, list(holdings.values()), skipped


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default="data/wallet.full.data.json")
    ap.add_argument("--dry-run", action="store_true", help="parse and report, write nothing")
    args = ap.parse_args()

    doc = load(pathlib.Path(args.src) if os.path.isabs(args.src) else ROOT / args.src)
    captured, traders, stats, wallets, tokens, holdings, skipped = shape(doc)

    priced = sum(1 for h in holdings if h[6] is not None)
    print(f"build      {captured.isoformat()}  (generated_at {doc['generated_at']})")
    print(f"traders    {len(traders)}")
    print(f"wallets    {len(wallets)} traders  "
          f"(evm {sum(1 for w in wallets if w[1])}, sol {sum(1 for w in wallets if w[3])})")
    print(f"tokens     {len(tokens)}")
    print(f"holdings   {len(holdings)}  ({priced} with a value, {len(holdings)-priced} without)")
    if skipped:
        print(f"skipped    {skipped} malformed rows")
    if args.dry_run:
        print("\ndry run — nothing written")
        return

    with psycopg.connect(db_url()) as conn:
        with conn.cursor() as cur:
            # The build row first: it records what the row tables cannot, notably the
            # leaderboard `window` the trader_stats figures describe.
            cur.execute("""
                insert into builds (captured_at, window_label, source, trader_count, holding_count)
                values (%s,%s,%s,%s,%s)
                on conflict (captured_at) do update set
                  window_label = excluded.window_label, source = excluded.source,
                  trader_count = excluded.trader_count, holding_count = excluded.holding_count
            """, (captured, doc.get("window"), (doc["traders"][0].get("src") or "fomoapi.io"),
                  len(traders), len(holdings)))

            # Order matters: every FK target before its dependants.
            cur.executemany("""
                insert into traders (handle, display_handle, name, avatar, bio, twitter, verified, source)
                values (%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (handle) do update set
                  display_handle = excluded.display_handle,
                  name = excluded.name, avatar = excluded.avatar, bio = excluded.bio,
                  twitter = excluded.twitter, verified = excluded.verified,
                  last_seen_at = now()
            """, traders)

            cur.executemany("""
                insert into tokens (network_id, address)
                values (%s,%s)
                on conflict (network_id, token_key) do update set last_seen_at = now()
            """, [(net, addr) for (net, _k), addr in tokens.items()])

            # An address only ever moves forward: coalesce keeps a previously known
            # address if a later build omits it, rather than blanking the row.
            cur.executemany("""
                insert into wallets (handle, evm_address, evm_source, sol_address, sol_source)
                values (%s,%s,%s,%s,%s)
                on conflict (handle) do update set
                  evm_address = coalesce(excluded.evm_address, wallets.evm_address),
                  evm_source  = coalesce(excluded.evm_source,  wallets.evm_source),
                  sol_address = coalesce(excluded.sol_address, wallets.sol_address),
                  sol_source  = coalesce(excluded.sol_source,  wallets.sol_source),
                  last_seen_at = now()
            """, wallets)

            cur.executemany("""
                insert into trader_stats (handle, captured_at, rank, pnl_usd, volume_usd, trade_count, followers)
                values (%s,%s,%s,%s,%s,%s,%s)
                on conflict (handle, captured_at) do update set
                  rank = excluded.rank, pnl_usd = excluded.pnl_usd, volume_usd = excluded.volume_usd,
                  trade_count = excluded.trade_count, followers = excluded.followers
            """, stats)

            cur.executemany("""
                insert into holdings (handle, network_id, token_key, captured_at, human_amount, price, value)
                values (%s,%s,%s,%s,%s,%s,%s)
                on conflict (handle, network_id, token_key, captured_at) do update set
                  human_amount = excluded.human_amount, price = excluded.price, value = excluded.value
            """, holdings)

            cur.execute("select count(distinct captured_at) from holdings")
            generations = cur.fetchone()[0]
        conn.commit()

    print(f"\nwrote generation {captured.isoformat()} — {generations} generation(s) now in the database")


if __name__ == "__main__":
    main()
