-- Linked wallets (docs/consumer/workflow-coverage-17-sep.md gap 5, W-J).
--
-- `wallets` holds one address per chain family per trader, so a second wallet a proven
-- trader funds from his known one had no home. This is that home: one row per (trader,
-- network, address), written nightly by scripts/link_wallets.mjs from native SOL transfers
-- and, with `watch`, added to the Helius registration by scripts/register_webhook.mjs.

create table if not exists linked_wallets (
  handle                  text        not null references traders(handle) on delete cascade,
  network_id              bigint      not null references chains(network_id),
  -- Lowercased, like transactions.counterparty it was found in.
  address_key             text        not null,
  -- Case-preserved base58, resolved from the evidence transaction; NULL when it could not
  -- be. Helius refuses a lowercased Solana address, so only rows with this are registered.
  address                 text,
  linked_from_address_key text        not null,
  link_kind               text        not null check (link_kind in ('funded_by', 'submitted')),
  first_seen_at           timestamptz,
  evidence_tx             text,
  watch                   boolean     not null default true,
  primary key (handle, network_id, address_key)
);
