import { sql, n, round } from "../db.ts";
import { get, post } from "../router.ts";
import { badRequest, notFound } from "../errors.ts";
import { intParam, parseIso } from "../shared/params.ts";
import { resolveTrader } from "../shared/traders.ts";
import { batchIds, batchEnvelope } from "../shared/batch.ts";
import {
  HISTORY_STEPS, HISTORY_WINDOWS, PUBLISH_FLOOR, type HistoryStep, type HistoryWindow,
  ageSeconds, confidence, defaultStep, fillHourGaps, isHistoryStep, isHistoryWindow,
  latestValued, windowRange,
} from "../shared/aum-history-rules.ts";

/**
 * Balance history BUILT from stored holdings and prices (17 Sep 2026), not sampled: the
 * hourly `aum_history` table and its daily / weekly / monthly rollup views, so a chart can
 * show any grain including the past. The legacy sampled series stays on /aum.
 *
 * The range is bounded (a window or from/to), so there is no cursor: `limit` keeps the
 * NEWEST points and the answer is ascending, newest last.
 *
 * `now` is the live figure from `aum_live`, refreshed when a watched wallet transacts, when a
 * balance slice reads the wallet, and when prices land; /aum/now serves it alone.
 *
 * `suspectUsd` / `unsellableUsd` (valuation v3, migration 20260918060000) is value the SQL kept
 * OUT of `totalUsd`: prices that failed value.ts's suspect rule, and honeypot positions.
 */
const LIMIT_MAX = 2000;

type Options = { step: HistoryStep; window: HistoryWindow; from: string | null; to: string; limit: number };
type RawOptions = { step?: unknown; window?: unknown; from?: unknown; to?: unknown };

const word = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().toLowerCase();

/** Shared by the GET and the batch POST so the two cannot drift on words or defaults. */
function options(raw: RawOptions, limit: number): Options {
  const window = word(raw.window) ?? "1w";
  if (!isHistoryWindow(window)) {
    throw badRequest(`'window' must be one of ${Object.keys(HISTORY_WINDOWS).join(", ")} — got '${String(raw.window)}'`,
      { parameter: "window" });
  }
  const step = word(raw.step);
  if (step !== null && !isHistoryStep(step)) {
    throw badRequest(`'step' must be one of ${HISTORY_STEPS.join(", ")} — got '${String(raw.step)}'`,
      { parameter: "step" });
  }
  const range = windowRange(window, new Date());
  const from = parseIso(raw.from, "from") ?? range.from;
  const to = parseIso(raw.to, "to") ?? range.to;
  if (from !== null && from >= to) {
    throw badRequest(`'from' must be before 'to' — got ${from} and ${to}`, { parameter: "from" });
  }
  return { step: step ?? defaultStep(window), window, from, to, limit };
}

type HourRow = {
  handle: string; at: Date | string; total_usd: string | null; suspect_usd: string | null;
  unsellable_usd: string | null; priced_positions: number; total_positions: number; basis: string;
  reason: string | null;
};
type BucketRow = {
  handle: string; at: Date | string; total_usd: string | null; high_usd: string | null;
  low_usd: string | null; valued_hours: number;
  /** The counts of the hour the close came from; null when the bucket has no valued hour. */
  priced_positions: number | null; total_positions: number | null;
};
type Point = {
  at: string; totalUsd: number | null; basis?: string; reason?: string | null;
  suspectUsd?: number | null; unsellableUsd?: number | null;
  pricedPositions?: number; totalPositions?: number;
  /** A4: the share of the wallet this figure was priced from, and whether that makes it partial. */
  pricedShare?: number | null; partial?: boolean; partialUsd?: number | null;
  highUsd?: number | null; lowUsd?: number | null; valuedHours?: number;
};

/**
 * The bucket of each rollup view (aum_history_daily / _weekly / _monthly), word for word. The
 * views window the WHOLE table before a handle filter can reach it, so `points` runs their body
 * over the asked handles instead. It differs from them in one thing: an hour `confidence()` would
 * withhold is not a valued hour of its bucket, where the views close a day on a 2-of-289 fragment.
 * tests/plans_aum-misc_test.ts holds the two equal over published hours; tests/aum_fixes_test.ts the rest.
 */
const bucketOf = (step: Exclude<HistoryStep, "1h">) => ({
  "1d": sql`strftime('%Y-%m-%dT00:00:00.000Z', hour)`,
  "1w": sql`strftime('%Y-%m-%dT00:00:00.000Z', hour, '-6 days', 'weekday 1')`,
  "1mo": sql`strftime('%Y-%m-01T00:00:00.000Z', hour)`,
})[step];

const iso = (v: Date | string): string => new Date(v).toISOString();

/** The newest `limit` points per handle inside the range, returned ascending. One query. */
async function points(handles: string[], o: Options): Promise<Map<string, Point[]>> {
  /* A bucket the range keeps starts at or after `from`, so no hour before it is needed: a seek bound, not a filter. */
  const since = o.from === null ? sql`` : sql`and hour >= ${o.from}`;
  const rows: (HourRow | BucketRow)[] = o.step === "1h"
    ? await sql<HourRow[]>`
        select handle, at, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason from (
          select handle, hour as at, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, basis, reason,
                 row_number() over (partition by handle order by hour desc) as rn
          from aum_history
          where handle in (${handles})
            and hour <= ${o.to}
            and (${o.from} is null or hour >= ${o.from})
        ) x where rn <= ${o.limit}
        order by handle, at`
    : await sql<BucketRow[]>`
        select handle, at, total_usd, high_usd, low_usd, valued_hours, priced_positions, total_positions from (
          select handle, bucket as at, total_usd, high_usd, low_usd, valued_hours, priced_positions, total_positions,
                 row_number() over (partition by handle order by bucket desc) as rn
          from (select handle, bucket,
                       max(case when rn = 1 then total_usd end) as total_usd,
                       max(case when rn = 1 and total_usd is not null then priced_positions end) as priced_positions,
                       max(case when rn = 1 and total_usd is not null then total_positions end) as total_positions,
                       max(total_usd) as high_usd, min(total_usd) as low_usd,
                       count(total_usd) as valued_hours
                from (select handle, bucket, total_usd, priced_positions, total_positions,
                             row_number() over (
                               partition by handle, bucket, total_usd is null
                               order by hour desc) as rn
                      -- pricedShare() and PUBLISH_FLOOR, in SQL: the same hours the 1h step publishes.
                      from (select handle, hour, priced_positions, total_positions, ${bucketOf(o.step)} as bucket,
                                   case when total_positions > 0
                                         and round(priced_positions * 1.0 / total_positions, 4) >= ${PUBLISH_FLOOR}
                                        then total_usd end as total_usd
                            from aum_history
                            where handle in (${handles}) ${since}))
                group by handle, bucket)
          where bucket <= ${o.to}
            and (${o.from} is null or bucket >= ${o.from})
        ) x where rn <= ${o.limit}
        order by handle, at`;
  const by = new Map<string, Point[]>();
  for (const r of rows) {
    let p: Point;
    if ("basis" in r) {
      /* A4: the stored total is judged against the coverage it came from before it is served. */
      const c = confidence({
        totalUsd: n(r.total_usd), pricedPositions: Number(r.priced_positions),
        totalPositions: Number(r.total_positions), reason: r.reason ?? null,
      });
      p = { at: iso(r.at), totalUsd: round(c.totalUsd), basis: r.basis, reason: c.reason,
            suspectUsd: round(n(r.suspect_usd)), unsellableUsd: round(n(r.unsellable_usd)),
            pricedPositions: Number(r.priced_positions), totalPositions: Number(r.total_positions),
            pricedShare: c.pricedShare, partial: c.partial, partialUsd: round(c.partialUsd) };
    } else {
      /* A4 on a bucket: its close is judged against the coverage of the hour it came from. */
      const c = confidence({
        totalUsd: n(r.total_usd), pricedPositions: Number(r.priced_positions ?? 0),
        totalPositions: Number(r.total_positions ?? 0), reason: null,
      });
      p = { at: iso(r.at), totalUsd: round(c.totalUsd), highUsd: round(n(r.high_usd)),
            lowUsd: round(n(r.low_usd)), valuedHours: Number(r.valued_hours),
            pricedShare: c.pricedShare, partial: c.partial, partialUsd: round(c.partialUsd) };
    }
    if (!by.has(r.handle)) by.set(r.handle, []);
    by.get(r.handle)!.push(p);
  }
  /* A3: an hour with no row is a null point with a reason, never a hole in the series. */
  if (o.step === "1h") {
    for (const [h, pts] of by) {
      by.set(h, fillHourGaps(pts, (at): Point => ({
        at, totalUsd: null, reason: "not_built", suspectUsd: null, unsellableUsd: null,
        pricedPositions: 0, totalPositions: 0, pricedShare: null, partial: false, partialUsd: null,
      })));
    }
  }
  return by;
}

/** When each handle's history was last built; the series' `asOf`. */
async function computedAt(handles: string[]): Promise<Map<string, string>> {
  const rows = await sql<{ handle: string; at: Date | string }[]>`
    select handle, max(computed_at) as at from aum_history where handle in (${handles}) group by handle`;
  const by = new Map<string, string>();
  for (const r of rows) by.set(r.handle, iso(r.at));
  return by;
}

type LiveRow = {
  handle: string; at: Date | string; total_usd: string | null; suspect_usd: string | null;
  unsellable_usd: string | null; priced_positions: number; total_positions: number;
  reason: string | null; source: string;
};
type Live = {
  at: string; totalUsd: number | null; suspectUsd: number | null; unsellableUsd: number | null;
  pricedPositions: number; totalPositions: number;
  /** A4: the same coverage rule the history points carry. */
  pricedShare: number | null; partial: boolean; partialUsd: number | null;
  reason: string | null; source: string; ageSeconds: number;
};

/** The live figure per handle from `aum_live`, one query; a handle with no row is absent. */
async function live(handles: string[]): Promise<Map<string, Live>> {
  const rows = await sql<LiveRow[]>`
    select handle, at, total_usd, suspect_usd, unsellable_usd, priced_positions, total_positions, reason, source
    from aum_live where handle in (${handles})`;
  const now = new Date();
  const by = new Map<string, Live>();
  for (const r of rows) {
    const c = confidence({
      totalUsd: n(r.total_usd), pricedPositions: Number(r.priced_positions),
      totalPositions: Number(r.total_positions), reason: r.reason ?? null,
    });
    by.set(r.handle, {
      at: iso(r.at), totalUsd: round(c.totalUsd), suspectUsd: round(n(r.suspect_usd)),
      unsellableUsd: round(n(r.unsellable_usd)), pricedPositions: Number(r.priced_positions),
      totalPositions: Number(r.total_positions),
      pricedShare: c.pricedShare, partial: c.partial, partialUsd: round(c.partialUsd),
      reason: c.reason, source: r.source,
      ageSeconds: ageSeconds(r.at, now),
    });
  }
  return by;
}

/** The newest `at` across live figures: the batch envelope's `asOf` for /aum/now. */
const newestAt = (figures: Map<string, Live>): string | null =>
  [...figures.values()].map((f) => f.at).sort().at(-1) ?? null;

const series = (display: string, id: string | null, o: Options, pts: Point[], asOf: string | null,
                now: Live | null) => {
  const valued = pts.filter((p) => p.totalUsd !== null);
  const last = latestValued(pts);
  return {
    handle: display,
    id,
    step: o.step,
    window: o.window,
    from: o.from,
    to: o.to,
    points: pts,
    count: pts.length,
    valued: valued.length,
    latest: last ? { at: last.at, totalUsd: last.totalUsd } : null,
    asOf,
    now,
  };
};

get("/v1/traders/:handle/aum/history", async ({ handle }, url) => {
  const u = url.searchParams;
  const o = options({ step: u.get("step"), window: u.get("window"), from: u.get("from"), to: u.get("to") },
    intParam(url, "limit", { min: 1, max: LIMIT_MAX, fallback: LIMIT_MAX }) ?? LIMIT_MAX);
  const [t] = await sql<{ id: string | null; handle: string; display_handle: string }[]>`
    select id, handle, display_handle from traders where handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);
  const [pts, built, figures] = await Promise.all([points([t.handle], o), computedAt([t.handle]), live([t.handle])]);
  return {
    ...series(t.display_handle, t.id ?? null, o, pts.get(t.handle) ?? [], built.get(t.handle) ?? null,
              figures.get(t.handle) ?? null),
    links: {
      self: `/v1/traders/${t.display_handle}/aum/history?step=${o.step}&window=${o.window}`,
      now: `/v1/traders/${t.display_handle}/aum/now`,
      aum: `/v1/traders/${t.display_handle}/aum`,
      trader: `/v1/traders/${t.display_handle}`,
    },
  };
});

get("/v1/traders/:handle/aum/now", async ({ handle }) => {
  const [t] = await sql<{ id: string | null; handle: string; display_handle: string }[]>`
    select id, handle, display_handle from traders where handle = ${await resolveTrader(handle)}`;
  if (!t) throw notFound(`no trader '${handle}' in the directory`);
  const figures = await live([t.handle]);
  return {
    handle: t.display_handle,
    id: t.id ?? null,
    now: figures.get(t.handle) ?? null,
    links: {
      self: `/v1/traders/${t.display_handle}/aum/now`,
      history: `/v1/traders/${t.display_handle}/aum/history`,
      aum: `/v1/traders/${t.display_handle}/aum`,
      trader: `/v1/traders/${t.display_handle}`,
    },
  };
});

post("/v1/traders/aum/now", async (_p, _url, body) => {
  const { requested, handles, asked, capped, traders } = await batchIds(body);
  const figures = await live(handles);
  return {
    ...batchEnvelope(asked, capped, newestAt(figures)),
    traders: requested.map((req, i) => {
      const h = handles[i];
      const t = traders.get(h);
      if (!t) {
        return { ok: false as const, requested: req, handle: null,
                 error: { code: "not_found", detail: `no trader '${req}' in the directory` } };
      }
      return { ok: true as const, requested: req, handle: t.display_handle, id: t.id, now: figures.get(h) ?? null };
    }),
  };
});

post("/v1/traders/aum/history", async (_p, _url, body) => {
  const { requested, handles, asked, capped, traders } = await batchIds(body);
  const o = options((body ?? {}) as RawOptions, LIMIT_MAX);
  const [pts, built, figures] = await Promise.all([points(handles, o), computedAt(handles), live(handles)]);
  const asOf = [...built.values()].sort().at(-1) ?? null;
  return {
    ...batchEnvelope(asked, capped, asOf),
    step: o.step,
    window: o.window,
    from: o.from,
    to: o.to,
    /* One row per requested id, successes and failures alike (mirrors POST /traders/flow). */
    traders: requested.map((req, i) => {
      const h = handles[i];
      const t = traders.get(h);
      if (!t) {
        return { ok: false as const, requested: req, handle: null,
                 error: { code: "not_found", detail: `no trader '${req}' in the directory` } };
      }
      return { ok: true as const, requested: req,
               ...series(t.display_handle, t.id, o, pts.get(h) ?? [], built.get(h) ?? null, figures.get(h) ?? null) };
    }),
  };
});
