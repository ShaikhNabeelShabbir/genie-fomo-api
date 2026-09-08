-- The quantity a trade leg should be weighted by when averaging entry/exit prices.
--
-- ISSUE-4: `avgEntryPrice` was the FIRST entry price per token, not an average. Averaging
-- needs a weight, and the obvious column does not supply one:
--
--   * On a CLOSED position `amount` is what REMAINS, which is nothing — it was sold. 2,378
--     of 3,220 closed trades hold exactly 0. This is the same defect that made BUG-1 wrong
--     by ~10^17, and weighting by it would repeat that mistake in a new place.
--   * On an OPEN position `amount` IS the position, so there it is exactly right.
--
-- So the weight is status-dependent. For closed legs the quantity is recovered from BUG-1's
-- own identity — realized pnl = qty x (exit - entry), hence qty = pnl / (exit - entry).
--
-- Measured over the 704 legs that actually need averaging: 116 open legs weighted from
-- `amount`, 574 closed legs recovered from the identity, 690 of 704 total (98.0%). At
-- position level 305 of 319 come out fully weighted, 14 partially, none with no weight.
--
-- Returns NULL when no weight can be established. A null weight drops the leg from the
-- average and is reported in the coverage; it is never silently treated as zero, which
-- would delete the leg while pretending the average was complete.
create or replace function trade_qty(
  p_status text,
  p_amount numeric,
  p_pnl    numeric,
  p_entry  numeric,
  p_exit   numeric
) returns numeric
language sql
immutable
as $$
  select case
    when p_status = 'open' and p_amount > 0 then p_amount
    when p_status = 'closed'
         and p_pnl   is not null
         and p_entry is not null
         and p_exit  is not null
         and p_exit <> p_entry
         and p_pnl / (p_exit - p_entry) > 0
      then p_pnl / (p_exit - p_entry)
    else null
  end
$$;

comment on function trade_qty(text, numeric, numeric, numeric, numeric) is
  'Weight for averaging a trade leg. Open legs use `amount`; closed legs recover quantity '
  'from realized pnl / (exit - entry), because `amount` on a closed trade is the remaining '
  'position (zero), not the traded size. NULL when no weight can be established.';
