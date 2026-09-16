-- N1 (docs/TO-DO-BEFORE-MIGRATION.md §2): native ETH and BNB counted nowhere.
--
-- `evmBalances` now reads eth_getBalance and pushes the native coin as a position under the
-- EVM sentinel address 0x0000000000000000000000000000000000000000, the same way Solana's
-- native SOL lives under the system-program key. These rows let it price like any other
-- quote asset (load_quote_prices.mjs maps ETH -> ETHUSDT, BNB -> BNBUSDT).
--
-- Deliberately NOT keyed under WETH/WBNB: a wallet holding both would collide on
-- (handle, network_id, token_key), and 1 ETH is not 1 WETH on chain.

insert into tokens (network_id, address, symbol, decimals) values
  (1,    '0x0000000000000000000000000000000000000000', 'ETH', 18),
  (56,   '0x0000000000000000000000000000000000000000', 'BNB', 18),
  (8453, '0x0000000000000000000000000000000000000000', 'ETH', 18),
  (4663, '0x0000000000000000000000000000000000000000', 'ETH', 18)
on conflict (network_id, token_key) do nothing;

insert into quote_assets (network_id, token_key, symbol, pegged_usd) values
  (1,    '0x0000000000000000000000000000000000000000', 'ETH', null),
  (56,   '0x0000000000000000000000000000000000000000', 'BNB', null),
  (8453, '0x0000000000000000000000000000000000000000', 'ETH', null),
  (4663, '0x0000000000000000000000000000000000000000', 'ETH', null)
on conflict (network_id, token_key) do nothing;
