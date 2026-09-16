-- Indexes behind the read paths the efficiency review measured as full scans
-- (docs/REVIEW_EFFICIENCY_17_SEP.md items 2 and 6). No data changes.
create index if not exists trades_handle_captured_idx on trades (handle, captured_at desc);
drop index if exists trades_handle_idx;
create index if not exists trades_captured_idx on trades (captured_at desc);
create index if not exists aum_samples_sampled_idx on aum_samples (sampled_at desc) where basis = 'sampled';
create index if not exists aum_chain_samples_net_at_idx on aum_chain_samples (network_id, at desc) where basis = 'sampled';
