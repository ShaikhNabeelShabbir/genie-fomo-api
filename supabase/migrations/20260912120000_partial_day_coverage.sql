-- Send the day with what we CAN price, and say what it covers.
--
-- Until now a rebuilt day was refused outright unless every chain the trader touches answered
-- at it. That followed AUM_CHART_PRD.md 3.2 -- "if one known wallet cannot be read, the whole
-- point is refused" -- written when a refused day meant we genuinely had nothing for it.
--
-- We now hold per-chain figures for all five chains, and the consumer measured what the old
-- rule costs: 8,894 days across the directory refused with one word, while the per-chain
-- answers carry real figures for the other chains on those very days. Only 109 of 434 traders
-- could draw a line from the all-chains answer; 309 could from a single chain. Among the
-- hundred largest it was 3 of 100 against 98 of 100.
--
-- So the rule changes from "refuse unless complete" to "state it, and state what it covers".
-- A partial total is only dangerous when it is silent about being partial, and these two
-- columns are what stop it being silent: every point now carries how many of the trader's
-- chains contributed to it. A day where NOTHING answered is still refused, because there is
-- no number to state.

alter table aum_samples
  -- Chains that returned a figure at this point.
  add column if not exists chains_answered integer,
  -- Chains the trader is known to touch. answered < expected means the total is a PART of
  -- him, not all of him, and a consumer can decide whether to draw it.
  add column if not exists chains_expected integer;

comment on column aum_samples.chains_answered is
  'How many of the trader chains reported a figure at this point. Less than chains_expected '
  'means total_usd is partial -- real, but not the whole trader.';
comment on column aum_samples.chains_expected is
  'How many chains the trader is known to touch, from holdings plus any chain with history.';
