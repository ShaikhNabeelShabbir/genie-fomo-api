import { assert, assertEquals } from "jsr:@std/assert@1";
import { openSchema } from "./_sqlite_harness.ts";
import { getDefaultSql } from "../supabase/functions/api/db.ts";
import { ranges } from "../worker/src/jobs/aum_history-core.ts";

/** The statement `ranges` issued until 19 Sep 2026, verbatim. */
const OLD_RANGES = `
    select handle, last_built, first_built, coalesce(min(held_from, read_from), held_from, read_from) as earliest
      from (
        select t.handle,
               (select max(hour) from aum_history a where a.handle = t.handle) as last_built,
               (select min(hour) from aum_history a where a.handle = t.handle) as first_built,
               (select min(captured_at) from holdings h where h.handle = t.handle and h.source = 'chain') as held_from,
               (select min(at) from aum_samples s where s.handle = t.handle
                  and s.basis in ('sampled', 'rebuilt') and s.total_usd is not null) as read_from
          from traders t
         where exists (select 1 from holdings h where h.handle = t.handle and h.source = 'chain')
            or exists (select 1 from aum_samples s where s.handle = t.handle and s.basis = 'sampled')
      )`;

Deno.test("ranges: the rows it read before, and held_from is a seek on the trader's own captures (cron CRON-05)", async () => {
  const prepared: string[] = [];
  const db = await openSchema((text) => void prepared.push(text));
  const run = (text: string, ...p: (string | number | null)[]): void => void db.prepare(text).run(...p);
  run("insert into tokens (network_id, address, token_key) values (1,'0xa','0xa')");
  const trader = (h: string): void => run("insert into traders (handle, display_handle, id) values (?,?,?)", h, h, `id-${h}`);
  const held = (h: string, at: string, source: "chain" | "fomo"): void =>
    run("insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values (?,1,'0xa',?,1,?)", h, at, source);
  const sample = (h: string, at: string, basis: "sampled" | "rebuilt", usd: number | null): void =>
    run("insert into aum_samples (handle, at, total_usd, basis, tier) values (?,?,?,?,'verified')", h, at, usd, basis);
  const built = (h: string, hour: string): void => run("insert into aum_history (handle, hour, basis) values (?,?,'priced')", h, hour);

  for (const h of ["early", "late", "fomo-first", "fomo-only", "sampled-only", "rebuilt-only", "refused-only", "sample-first", "built", "nothing"]) trader(h);
  held("early", "2026-09-01T00:10:00.000Z", "chain");
  held("early", "2026-09-05T00:10:00.000Z", "chain");
  held("late", "2026-09-18T23:10:00.000Z", "chain");         // joined after the sampler retired: read_from is null
  held("fomo-first", "2026-08-01T00:00:00.000Z", "fomo");    // a directory capture is not a chain read
  held("fomo-first", "2026-09-03T00:10:00.000Z", "chain");
  held("fomo-only", "2026-08-01T00:00:00.000Z", "fomo");
  sample("sampled-only", "2026-09-02T04:00:00.000Z", "sampled", 10);
  sample("rebuilt-only", "2026-09-02T04:00:00.000Z", "rebuilt", 10);
  sample("refused-only", "2026-09-02T04:00:00.000Z", "sampled", null); // listed, then dropped: no earliest hour
  held("sample-first", "2026-09-04T00:10:00.000Z", "chain");
  sample("sample-first", "2026-09-02T04:00:00.000Z", "rebuilt", 10);
  held("built", "2026-09-01T00:10:00.000Z", "chain");
  built("built", "2026-09-01T00:00:00.000Z");
  built("built", "2026-09-07T05:00:00.000Z");

  const now = await ranges(getDefaultSql()!);
  const was = (db.prepare(OLD_RANGES).all() as { handle: string; last_built: string | null; first_built: string | null; earliest: string | null }[])
    .filter((r) => r.earliest !== null)
    .map((r) => ({
      handle: r.handle,
      lastBuilt: r.last_built ? new Date(r.last_built) : null,
      firstBuilt: r.first_built ? new Date(r.first_built) : null,
      earliest: new Date(r.earliest!),
    }));
  assertEquals(now, was);
  assertEquals(now.map((r) => [r.handle, r.earliest.toISOString(), r.lastBuilt?.toISOString() ?? null]).sort(), [
    ["built", "2026-09-01T00:10:00.000Z", "2026-09-07T05:00:00.000Z"],
    ["early", "2026-09-01T00:10:00.000Z", null],
    ["fomo-first", "2026-09-03T00:10:00.000Z", null],
    ["late", "2026-09-18T23:10:00.000Z", null],
    ["sample-first", "2026-09-02T04:00:00.000Z", null],
    ["sampled-only", "2026-09-02T04:00:00.000Z", null],
  ]);

  /* The old plan walked (source, captured_at) from the oldest chain capture up to this trader's first, per trader. */
  const issued = prepared.filter((t) => t.includes("as held_from"));
  assertEquals(issued.length, 1);
  const plan = (text: string): string[] => (db.prepare(`explain query plan ${text}`).all() as { detail: string }[]).map((r) => r.detail);
  assert(plan(OLD_RANGES).some((d) => d.includes("holdings_source_capture_idx")), "the old text no longer plans as the finding says");
  assert(!plan(issued[0]).some((d) => d.includes("holdings_source_capture_idx")), plan(issued[0]).join("\n"));
  assert(plan(issued[0]).some((d) => d.startsWith("SEARCH h USING") && d.includes("holdings_handle_idx (handle=?)")), plan(issued[0]).join("\n"));
});
