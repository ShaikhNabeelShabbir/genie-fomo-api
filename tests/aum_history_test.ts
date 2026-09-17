import { assertEquals } from "jsr:@std/assert@1";
import { planChunks, planWork, truncHour } from "../worker/src/jobs/aum_history-core.ts";

/* Rule 3 of the 18 Sep 2026 aum_history decision: resume after the last built hour, always
   redo the last two hours, chunk at <= 168 h, oldest first. */

const H = 3_600_000;
const now = new Date("2026-09-18T10:42:17Z");
const iso = (d: Date): string => d.toISOString();
const spans = (cs: readonly { from: Date; to: Date; hours: number }[]): [string, string, number][] =>
  cs.map((c) => [iso(c.from), iso(c.to), c.hours]);

Deno.test("truncHour: floors to the hour in UTC", () => {
  assertEquals(iso(truncHour(now)), "2026-09-18T10:00:00.000Z");
});

Deno.test("planChunks: fresh trader starts at the earliest source hour and ends at the current hour", () => {
  const earliest = new Date("2026-09-18T07:20:00Z");
  assertEquals(spans(planChunks({ handle: "a", lastBuilt: null, earliest }, now)),
    [["2026-09-18T07:00:00.000Z", "2026-09-18T10:00:00.000Z", 4]]);
});

Deno.test("planChunks: fully built trader still recomputes the last two hours", () => {
  const t = { handle: "a", lastBuilt: new Date("2026-09-18T10:00:00Z"), earliest: new Date("2026-09-01T00:00:00Z") };
  assertEquals(spans(planChunks(t, now)), [["2026-09-18T09:00:00.000Z", "2026-09-18T10:00:00.000Z", 2]]);
});

Deno.test("planChunks: resumes the hour after lastBuilt when behind by more than two hours", () => {
  const t = { handle: "a", lastBuilt: new Date("2026-09-18T03:00:00Z"), earliest: new Date("2026-09-01T00:00:00Z") };
  assertEquals(spans(planChunks(t, now)), [["2026-09-18T04:00:00.000Z", "2026-09-18T10:00:00.000Z", 7]]);
});

Deno.test("planChunks: a long backlog is cut into 168-hour chunks, oldest first, last one short", () => {
  const earliest = new Date(truncHour(now).getTime() - 400 * H);
  const chunks = planChunks({ handle: "a", lastBuilt: null, earliest }, now);
  assertEquals(chunks.map((c) => c.hours), [168, 168, 65]);
  assertEquals(iso(chunks[0].from), iso(earliest));
  assertEquals(iso(chunks[2].to), "2026-09-18T10:00:00.000Z");
  for (let i = 1; i < chunks.length; i++) assertEquals(chunks[i].from.getTime(), chunks[i - 1].to.getTime() + H);
});

Deno.test("planChunks: never starts before the earliest source hour, even for the recompute window", () => {
  const earliest = new Date("2026-09-18T10:05:00Z");
  assertEquals(spans(planChunks({ handle: "a", lastBuilt: null, earliest }, now)),
    [["2026-09-18T10:00:00.000Z", "2026-09-18T10:00:00.000Z", 1]]);
  assertEquals(planChunks({ handle: "a", lastBuilt: null, earliest: new Date("2026-09-18T11:00:00Z") }, now), []);
});

Deno.test("planWork: chunks across traders are ordered by from, so a backfill is shared", () => {
  const work = planWork([
    { handle: "new", lastBuilt: null, earliest: new Date(truncHour(now).getTime() - 200 * H) },
    { handle: "old", lastBuilt: new Date("2026-09-18T10:00:00Z"), earliest: new Date("2026-09-01T00:00:00Z") },
  ], now);
  assertEquals(work.map((c) => [c.handle, c.hours]), [["new", 168], ["new", 33], ["old", 2]]);
});

Deno.test("planChunks: a source that reaches further back than the first built hour is backfilled before it", () => {
  const now = new Date("2026-09-18T10:30:00Z");
  const t = { handle: "a", lastBuilt: new Date("2026-09-18T10:00:00Z"), firstBuilt: new Date("2026-09-09T08:00:00Z"), earliest: new Date("2026-09-09T05:00:00Z") };
  const spans = planChunks(t, now).map((c) => [c.from.toISOString(), c.to.toISOString(), c.hours]);
  assertEquals(spans[0], ["2026-09-09T05:00:00.000Z", "2026-09-09T07:00:00.000Z", 3]);
  assertEquals(spans[spans.length - 1], ["2026-09-18T09:00:00.000Z", "2026-09-18T10:00:00.000Z", 2]);
});
