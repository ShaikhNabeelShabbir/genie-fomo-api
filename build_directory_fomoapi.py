#!/usr/bin/env python3
"""
build_directory_fomoapi.py  —  builds data/wallet.full.data.json from fomoapi.io.

The token-free alternative to build_directory.py. fomoapi authenticates with a static
key instead of a privy cookie that expires hourly, so this can run unattended on a cron.

SETUP
  export FOMOAPI_KEY="fapi_..."            # https://fomoapi.io
  python3 build_directory_fomoapi.py       # -> data/wallet.full.data.json

  python3 build_directory_fomoapi.py --out /tmp/t.json --top 10    # dry run
  python3 build_directory_fomoapi.py --no-holdings          # names only; wallets WILL be null

WHAT IT PULLS
  1. /v2/leaderboard/{window}  one call -> handles plus each trader's resolved wallets.
     On the top 100: 85 have an EVM address, 78 Solana, 15 neither.
  2. /v2/users/{handle}/trades + /balances -> current positions, merged. /trades is the
     only source of EVM positions; /balances is Solana-only but is live and covers traders
     whose trades are all closed. Together they are the fingerprint the resolver verifies.

Wallets land in `src_evm` / `src_sol`, NOT `evm` / `sol`. That is deliberate — `evm`/`sol`
mean "the wallet fomo provisioned", which holds none of the trader's positions, and
overwriting them would quietly invert the field's meaning. The API treats src_* as an
independent second opinion that can corroborate our own resolution, never as a verdict.

Positions carry no chain id, so networkId is recovered with eth_getCode (see
detect_networks). Verified: three of theveeman's open EVM positions resolved to base, bsc
and robinhood respectively, and balanceOf at the address fomoapi reports matched all three
to 0.0000%.

KNOWN LIMITS VS THE PRIVY-TOKEN PATH
  * Caps at 100 traders; `offset` is ignored, so 101-150 are unreachable. And
    /v2/users/{handle} returns "trader not found" for anyone outside the top 100 — this
    cannot serve arbitrary handles.
  * Leaderboard measured ~13h stale and /trades ~6d, so an active trader's position sizes
    can drift past the resolver's 15% band. Positions that no longer match simply fail to
    resolve; they do not produce a wrong answer.
"""

import argparse
import json
import os
import pathlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

API = os.environ.get("FOMOAPI_BASE", "https://api.fomoapi.io")
KEY = os.environ.get("FOMOAPI_KEY", "").strip()
WINDOW = os.environ.get("WINDOW", "30d")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")

SOLANA_NETWORK_ID = 1399811149
session = requests.Session()


def die(msg: str) -> None:
    """Every failure path exits non-zero — a cron must never read a failure as success."""
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def api_get(path: str, tries: int = 3):
    headers = {"authorization": f"Bearer {KEY}", "Accept": "application/json", "User-Agent": UA}
    for attempt in range(tries):
        try:
            r = session.get(f"{API}{path}", headers=headers, timeout=45)
        except Exception as e:
            if attempt == tries - 1:
                return None, f"{type(e).__name__}: {e}"
            time.sleep(1.5 * (attempt + 1))
            continue
        if r.status_code == 429:
            time.sleep(float(r.headers.get("retry-after", 5)))
            continue
        if r.status_code in (401, 403):
            return None, f"HTTP {r.status_code} — key rejected"
        if not r.ok:
            if attempt == tries - 1:
                return None, f"HTTP {r.status_code}"
            time.sleep(1.5 * (attempt + 1))
            continue
        try:
            return r.json(), None
        except Exception:
            return None, "response was not JSON"
    return None, "exhausted retries"


_net_cache: dict[str, list[int]] = {}
EVM_CHAINS = [
    (4663, "https://rpc.mainnet.chain.robinhood.com"),
    (1, "https://ethereum-rpc.publicnode.com"),
    (56, "https://bsc-dataseed.binance.org"),
    (8453, "https://mainnet.base.org"),
]


def _has_code(rpc: str, addr: str) -> bool:
    """eth_getCode returns '0x' where nothing is deployed. The User-Agent matters — some
    of these RPCs reject a bare client with 403."""
    try:
        r = session.post(rpc, timeout=20,
                         headers={"Content-Type": "application/json", "User-Agent": UA},
                         json={"jsonrpc": "2.0", "id": 1, "method": "eth_getCode",
                               "params": [addr, "latest"]})
        return len(r.json().get("result", "0x")) > 2
    except Exception:
        return False


def detect_networks(addr: str) -> list[int]:
    """fomoapi never returns a chain id, so recover it from the chain itself. A contract
    can exist at one address on several EVM chains, so every hit is returned and the
    caller emits the position once per chain — the resolver finds no holder on the wrong
    one and self-corrects, which beats guessing."""
    if addr in _net_cache:
        return _net_cache[addr]
    if not addr.startswith("0x"):
        _net_cache[addr] = [SOLANA_NETWORK_ID]
        return _net_cache[addr]
    with ThreadPoolExecutor(max_workers=4) as pool:
        found = list(pool.map(lambda c: _has_code(c[1], addr), EVM_CHAINS))
    _net_cache[addr] = [EVM_CHAINS[i][0] for i, ok in enumerate(found) if ok]
    return _net_cache[addr]


def open_positions(handle: str, limit: int) -> list[dict]:
    """Current positions — the fingerprint the resolver verifies against.

    Two sources, because neither is complete on its own:

      /trades (status=open)  the ONLY source of EVM positions. /balances is Solana-only.
                             Measured ~6d stale, so sizes drift.
      /balances              Solana only, but measured LIVE, and it covers traders whose
                             trades are all closed (Quanterty: 0 open trades, 30 holdings).

    Merged and deduped by (token, chain). /balances wins on conflict for Solana since it
    is the fresher number.
    """
    merged: dict[tuple, dict] = {}

    trades, err = api_get(f"/v2/users/{handle}/trades?limit={limit}")
    if err:
        print(f"  ! {handle}: trades unavailable ({err})", file=sys.stderr)
    for t in (trades or {}).get("trades") or []:
        if t.get("status") != "open":
            continue
        addr = (t.get("token") or {}).get("address")
        amount = t.get("amount")
        if not addr or not amount or amount <= 0:
            continue
        for net in detect_networks(addr):
            merged[(addr, net)] = {
                "tokenAddress": addr, "networkId": net,
                "humanAmount": amount, "price": t.get("avgEntryPrice"),
            }

    bal, err = api_get(f"/v2/users/{handle}/balances")
    if err:
        print(f"  ! {handle}: balances unavailable ({err})", file=sys.stderr)
    for h in (bal or {}).get("holdings") or []:
        addr = (h.get("token") or {}).get("address")
        amount = h.get("amount")
        if not addr or addr.startswith("0x") or not amount or amount <= 0:
            continue   # /balances is Solana-only; a 0x here would be unexpected
        merged[(addr, SOLANA_NETWORK_ID)] = {
            "tokenAddress": addr, "networkId": SOLANA_NETWORK_ID,
            "humanAmount": amount, "price": h.get("priceUsd"), "value": h.get("valueUsd"),
        }

    return list(merged.values())


def build(top_n: int, with_holdings: bool, trade_limit: int) -> list[dict]:
    lb, err = api_get(f"/v2/leaderboard/{WINDOW}?limit={min(top_n, 100)}")
    if err:
        die(f"leaderboard fetch failed: {err}")
    rows = (lb or {}).get("traders") or []
    if not rows:
        die("leaderboard returned no traders")
    print(f"leaderboard: {len(rows)} traders (capturedAt {lb.get('capturedAt')})")

    entries = []
    for i, t in enumerate(rows[:top_n], 1):
        handle = t.get("handle")
        if not handle:
            continue
        w = t.get("wallets") or {}
        entries.append({
            "handle": handle,
            "name": t.get("displayName") or handle,
            "rank": t.get("rank") or i,
            # fomo's provisioned wallets — fomoapi does not expose them, and they hold
            # nothing anyway, so they stay empty rather than being faked.
            "evm": "",
            "sol": "",
            # Third-party resolved wallets. A second opinion, not a verdict.
            "src_evm": (w.get("evm") or "").lower(),
            "src_sol": w.get("solana") or "",
            "src": "fomoapi.io",
            "pnl": t.get("pnlUsd") or 0,
            "volume": t.get("volumeUsd") or 0,
            "trades": int(t.get("trades") or 0),
            "followers": int(t.get("followers") or 0),
            "avatar": t.get("avatar") or "",
            "bio": "",
            "twitter": "",
            "verified": bool(t.get("verified")),
            "holdings": [],
        })

    if with_holdings:
        print(f"fetching open positions for {len(entries)} traders…")
        with ThreadPoolExecutor(max_workers=6) as pool:
            for e, h in zip(entries, pool.map(
                    lambda x: open_positions(x["handle"], trade_limit), entries)):
                e["holdings"] = h
        tot = sum(len(e["holdings"]) for e in entries)
        evm = sum(1 for e in entries for h in e["holdings"] if h["networkId"] != SOLANA_NETWORK_ID)
        print(f"  {tot} open positions ({evm} EVM, {tot - evm} Solana), "
              f"{len(_net_cache)} tokens chain-detected")

    with_evm = sum(1 for e in entries if e["src_evm"])
    with_sol = sum(1 for e in entries if e["src_sol"])
    print(f"addresses: {with_evm} EVM, {with_sol} Solana, "
          f"{sum(1 for e in entries if not e['src_evm'] and not e['src_sol'])} with neither")
    return entries


def validate(entries: list[dict], out: pathlib.Path, force: bool) -> None:
    """Refuse to publish a bad build. A partial response replacing a good directory is
    worse than skipping the refresh entirely."""
    if not entries:
        die("no traders parsed")
    if not all(e.get("handle") for e in entries):
        die("some traders have no handle")

    positions = sum(len(e["holdings"]) for e in entries)
    if positions == 0 and not force:
        die("no open positions were fetched, so no address can be verified and every "
            "wallet lookup would return null. Drop --no-holdings, or pass --force if a "
            "names-only directory is genuinely what you want.")

    with_addr = sum(1 for e in entries if e["src_evm"] or e["src_sol"])
    if with_addr < len(entries) * 0.5:
        die(f"only {with_addr}/{len(entries)} traders have any address — refusing to publish")

    if out.exists() and not force:
        try:
            prev = len(json.load(open(out)).get("traders", []))
        except Exception:
            prev = 0
        if prev and len(entries) < prev * 0.8:
            die(f"got {len(entries)} traders but the existing file has {prev} — refusing to "
                f"shrink it by more than 20%. Pass --force if that is intended.")
    print(f"validated: {len(entries)} traders, {with_addr} with an address, "
          f"{positions} open positions")


def write_atomic(entries: list[dict], out: pathlib.Path) -> None:
    """Temp file then rename. The API re-reads on mtime change, so a partial write could
    otherwise be served to a live request."""
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = {"window": WINDOW, "generated_at": int(time.time()),
           "source": "fomoapi.io", "traders": entries}
    tmp = out.with_suffix(out.suffix + ".tmp")
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=2)
    os.replace(tmp, out)
    print(f"\nwrote {out} — {len(entries)} traders, generated_at {doc['generated_at']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/wallet.full.data.json")
    ap.add_argument("--top", type=int, default=100, help="max traders (fomoapi caps at 100)")
    ap.add_argument("--no-holdings", action="store_true",
                    help="skip open positions. The directory can then serve names and ranks "
                         "but NOT wallets — nothing can be verified, so every address "
                         "resolves to null. Rarely what you want.")
    ap.add_argument("--trade-limit", type=int, default=100,
                    help="trades fetched per trader when --with-holdings is set")
    ap.add_argument("--force", action="store_true", help="skip the shrink floor check")
    args = ap.parse_args()

    if not KEY:
        die("FOMOAPI_KEY is not set — export it and rerun")

    out = pathlib.Path(args.out)
    started = time.time()
    entries = build(args.top, not args.no_holdings, args.trade_limit)
    validate(entries, out, args.force)
    write_atomic(entries, out)
    print(f"done in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
