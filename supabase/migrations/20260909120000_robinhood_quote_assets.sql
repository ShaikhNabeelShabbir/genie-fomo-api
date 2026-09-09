-- Step 4a of AXIS_ALIGNMENT.md §6 — the EVM swap resolver needs a quote side.
--
-- robinhood is 47.8% of all trades and had ZERO rows in quote_assets, so the resolver's
-- quote/token split could never have succeeded there: every swap would have looked like
-- two non-quote tokens and been discarded. This is the reference data that unblocks it.
--
-- The chain is Robinhood's tokenised-equity chain -- the tokens traded on it are NVDA, GME,
-- AMC, COST, GLD -- so the quote side is a stablecoin or WETH rather than a memecoin pair.

-- USDG, Paxos's Global Dollar. 6 decimals. Confirmed by reading symbol() and name() from
-- the contract, not from a label: "USDG" / "Global Dollar". It is the most-transferred token
-- on the chain in our data (2,245 legs across 63 of our wallets), which is what a quote
-- currency looks like.
insert into quote_assets (network_id, token_key, symbol, pegged_usd)
values (4663, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG', 1)
on conflict (network_id, token_key) do nothing;

-- WETH. Floating, so no peg -- it prices through token_prices / token_info like any other
-- floating quote asset.
insert into quote_assets (network_id, token_key, symbol, pegged_usd)
values (4663, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', 'WETH', null)
on conflict (network_id, token_key) do nothing;

-- DELIBERATELY NOT ADDED: 0x3ae0689f64b8a7683d06a9e358d7346dc5e71e18.
--
-- Its symbol() returns "USDC" and it was the obvious third candidate. Its name() returns
-- "Unstable Coin" and it carries 18 decimals rather than USDC's 6. It is a memecoin wearing
-- USDC's ticker. Adding it would have valued every holding of it at $1 and counted it as
-- cash in Axis 4's cashShare -- a wrong number that would have looked entirely reasonable.
--
-- The symbol column in any token table is attacker-controlled. This one was caught by asking
-- the contract for its name, and nothing else would have caught it.
