#!/usr/bin/env python3
"""
build_directory.py  —  builds data/wallet.full.data.json for the genie-fomo app.

Runs LOCALLY with your fomo token. Walks the 30d leaderboard, resolves each handle to
its wallet(s) + profile info, and writes a cached directory the Next.js app reads.
The token NEVER leaves your machine and is NEVER committed — only the directory ships.

Reuses ether_scan1.py's Bearer-auth approach (the fix for the cookie 431).

SETUP
  export FOMO_TOKEN="your_privy_token"     # from fomo.family cookies; expires ~hourly
  python3 build_directory.py               # -> data/wallet.full.data.json  (+ raw/ dumps)

  python3 build_directory.py --offline     # no token: rebuild the directory from the
                                           # raw/leaderboard.json already on disk

Re-run on a cadence (daily, or before a demo) to refresh names — the leaderboard reshuffles.
"""

import os, sys, json, time, pathlib
import requests

FOMO_TOKEN = os.environ.get("FOMO_TOKEN", "").strip().replace("\n", "").replace("\r", "").replace(" ", "")
FOMO_API = "https://prod-api.fomo.family/v2"
WINDOW   = os.environ.get("WINDOW", "30d")     # 24h | 7d | 30d
TOP_N    = int(os.environ.get("TOP_N", "150"))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")

RAW = pathlib.Path("raw"); RAW.mkdir(exist_ok=True)
DATA = pathlib.Path("data"); DATA.mkdir(exist_ok=True)
# The filename the API reads by default (see src/settings.ts). Writing straight to it
# means a run is live on the next request — there is no copy step left to forget.
OUT = DATA / "wallet.full.data.json"


def fomo_get(path):
    """GET a fomo endpoint with Bearer auth (dodges the cookie 431), cookie fallback."""
    url = f"{FOMO_API}/{path}"
    base = {"User-Agent": UA, "Accept": "application/json"}
    for mode, hdr in (("bearer", {**base, "Authorization": f"Bearer {FOMO_TOKEN}"}),
                      ("cookie", {**base, "Cookie": f"privy-token={FOMO_TOKEN}"})):
        try:
            r = requests.get(url, headers=hdr, timeout=30)
        except Exception as e:
            print(f"  ! {mode} {path}: {e}"); continue
        if r.status_code == 431:
            print(f"  ! {mode} {path}: 431 header too large — next method"); continue
        if r.status_code in (401, 403):
            print(f"  ! {mode} {path}: {r.status_code} token rejected/expired — next method"); continue
        if r.ok:
            try: return r.json()
            except Exception: return None
        print(f"  ! {mode} {path}: HTTP {r.status_code}")
    return None


def find_addresses(obj):
    evm = sol = ""
    def walk(o):
        nonlocal evm, sol
        if isinstance(o, dict):
            for k, v in o.items():
                kl = k.lower()
                if isinstance(v, str):
                    if not evm and ("evm" in kl or "eth" in kl) and v.startswith("0x") and len(v) == 42: evm = v.lower()
                    if not sol and "sol" in kl and 32 <= len(v) <= 44 and not v.startswith("0x"): sol = v
                walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(obj)
    return evm, sol


def _num(v):
    try: return float(v)
    except (TypeError, ValueError): return 0.0


def extract_entries(lb):
    """The live shape is {success, responseObject: {leaderboard: [...]}}; older/other
    shapes nest the array under data/users/entries. Handle all of them."""
    arr = lb
    if isinstance(lb, dict):
        ro = lb.get("responseObject")
        if isinstance(ro, dict):
            lb = ro
        elif isinstance(ro, list):
            arr = ro
    if isinstance(lb, dict):
        for k in ("leaderboard", "data", "users", "entries", "results", "items"):
            if isinstance(lb.get(k), list): arr = lb[k]; break

    out = []
    if isinstance(arr, list):
        for e in arr:
            if not isinstance(e, dict): continue
            u = e.get("user") if isinstance(e.get("user"), dict) else e
            handle = u.get("userHandle") or u.get("handle") or u.get("username")
            if not handle: continue
            # the leaderboard already carries both wallets — no profile call needed
            evm = (u.get("evmAddress") or "").lower()
            sol = u.get("address") or u.get("solanaAddress") or ""
            if sol.startswith("0x"): sol = ""
            out.append({
                "handle": handle,
                "name": u.get("displayName") or u.get("name") or handle,
                "evm": evm,
                "sol": sol,
                "pnl": _num(e.get(f"pnl{WINDOW}") or e.get("pnl30d") or e.get("pnl")
                            or e.get("realizedPnl") or e.get("profit")),
                "volume": _num(u.get("totalVolume")),
                "trades": int(_num(u.get("numTrades") or u.get("swapCount"))),
                "followers": int(_num(u.get("followers"))),
                "avatar": u.get("profilePictureLink") or "",
                "bio": (u.get("description") or "").strip(),
                "twitter": u.get("twitter") or "",
                "verified": bool(u.get("verified")),
                "holdings": u.get("topHoldings") or [],
            })
    return out


def write_directory(entries):
    json.dump({"window": WINDOW, "generated_at": int(time.time()), "traders": entries},
              open(OUT, "w"), indent=2)
    resolved = sum(1 for d in entries if d["evm"] or d["sol"])
    print(f"\nwrote {OUT} — {resolved}/{len(entries)} resolved to a wallet.")


def main():
    offline = "--offline" in sys.argv
    if offline or not FOMO_TOKEN:
        path = RAW / "leaderboard.json"
        if not path.exists():
            print("Set FOMO_TOKEN (your fomo.family privy-token) and rerun, "
                  "or drop a leaderboard dump at raw/leaderboard.json for --offline."); return
        print(f"offline: rebuilding from {path}…")
        entries = extract_entries(json.load(open(path)))[:TOP_N]
        if not entries:
            print("Couldn't parse handles out of raw/leaderboard.json."); return
        for i, e in enumerate(entries, 1): e["rank"] = i
        write_directory(entries); return

    print(f"FOMO_TOKEN loaded ({len(FOMO_TOKEN)} chars). Pulling {WINDOW} leaderboard, top {TOP_N}…")
    lb = fomo_get(f"leaderboard/{WINDOW}")
    if lb is None:
        print("Leaderboard fetch failed (token expired? grab a fresh one)."); return
    json.dump(lb, open(RAW / "leaderboard.json", "w"), indent=2)
    entries = extract_entries(lb)[:TOP_N]
    if not entries:
        print("Got a leaderboard response but couldn't parse handles.")
        print("Open raw/leaderboard.json and send it over — one line fixes the parser."); return
    print(f"parsed {len(entries)} handles. Filling in any missing wallets…")

    dumped = False
    for i, e in enumerate(entries, 1):
        e["rank"] = i
        if not (e["evm"] or e["sol"]):
            prof = fomo_get(f"users/userHandle/{e['handle']}")
            if prof and not dumped:
                json.dump(prof, open(RAW / f"profile_{e['handle']}.json", "w"), indent=2); dumped = True
            e["evm"], e["sol"] = find_addresses(prof or {})
            time.sleep(0.2)
        print(f"  {i:>3}. {e['handle']:<24} evm={e['evm'][:10] or '-':<10} sol={e['sol'][:10] or '-'}")

    write_directory(entries)


if __name__ == "__main__":
    main()
