-- G2: a token's logo. GMGN's /v1/token/info document carries `logo` (promoted from `raw` by the
-- nightly tokens job); DexScreener's pair `info.imageUrl` fills the gap on the hourly prices job
-- when GMGN gave none. NULL means no source has one, never "no logo".
alter table token_info add column if not exists logo_url text;
comment on column token_info.logo_url is 'Token image URL: GMGN `logo` first, DexScreener `info.imageUrl` when GMGN has none; null when neither does.';
