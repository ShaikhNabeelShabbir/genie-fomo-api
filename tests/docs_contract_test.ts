import { assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import { openSchema } from "./_sqlite_harness.ts";
import { handle } from "../supabase/functions/api/app.ts";
import { refreshHealthSnapshot } from "../supabase/functions/api/routes/health.ts";
import { VOCABULARY } from "../supabase/functions/api/shared/vocabulary.ts";
import "../supabase/functions/api/routes.ts";

/*
 * The documents the app team holds are a contract too (19 Sep 2026). The /health schema required a
 * key v2 stopped emitting on 17 Sep and refused two published words; the handoff copy of the spec
 * sat two waves behind while its README called it "the same file". These fail on the next drift.
 */
type Schema = Readonly<Record<string, unknown>>;

const read = (path: string): Promise<string> => Deno.readTextFile(new URL(path, import.meta.url));
const specText = await read("../docs/openapi.yaml");
const spec = parse(specText) as { components: { schemas: Record<string, Schema> }; paths: Record<string, Record<string, unknown>> };
const schemas = spec.components.schemas;

/** A schema with its `$ref` followed and its `allOf` parts folded into one object schema. */
function resolve(schema: Schema): Schema {
  if (typeof schema.$ref === "string") return resolve(schemas[schema.$ref.split("/").pop() as string]);
  const parts = ((schema.allOf ?? []) as Schema[]).map(resolve);
  if (!parts.length) return schema;
  return {
    ...Object.assign({}, ...parts), ...schema,
    required: [...parts, schema].flatMap((p) => (p.required ?? []) as string[]),
    properties: Object.assign({}, ...[...parts, schema].map((p) => p.properties ?? {})),
  };
}

const TYPE_OF: Readonly<Record<string, (v: unknown) => boolean>> = {
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && !Array.isArray(v),
};

/** Every way `value` breaks `schema`: a missing required key, a word outside an enum, a wrong type, a key the spec does not name. */
function violations(value: unknown, schema: Schema, path: string): string[] {
  const s = resolve(schema);
  if (value === null) return s.nullable ? [] : [`${path}: null, and the schema is not nullable`];
  const type = s.type as string | undefined;
  if (type && !TYPE_OF[type](value)) return [`${path}: ${JSON.stringify(value)} is not ${type}`];
  if (s.enum && !(s.enum as unknown[]).includes(value)) return [`${path}: ${JSON.stringify(value)} is not in the enum`];
  if (s.format === "date-time" && Number.isNaN(Date.parse(value as string))) return [`${path}: not a date-time`];
  if (Array.isArray(value)) return value.flatMap((v, i) => violations(v, (s.items ?? {}) as Schema, `${path}[${i}]`));
  if (typeof value !== "object") return [];
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const extra = s.additionalProperties as Schema | undefined;
  const body = value as Record<string, unknown>;
  return [
    ...((s.required ?? []) as string[]).filter((k) => !(k in body)).map((k) => `${path}.${k}: required by the spec, not emitted`),
    ...Object.entries(body).flatMap(([k, v]) =>
      props[k] ? violations(v, props[k], `${path}.${k}`)
        : extra ? violations(v, extra, `${path}.${k}`)
        : [`${path}.${k}: emitted, not in the spec`]),
  ];
}

const db = await openSchema();
const ago = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();
const SAMPLED_AT = ago(4);
/** One dated row behind every nullable key: a null passes any nullable schema, so an empty database cannot catch a wrong type. */
const SEED: ReadonlyArray<readonly [string, ...string[]]> = [
  ["insert into builds (captured_at, window_label, trader_count, holding_count) values (?,'30d',1,1)", ago(1)],
  ["insert into traders (handle, display_handle, id) values ('a','a','id-a')"],
  ["insert into wallets (handle, evm_address, sol_address) values ('a','0xWa','SolA')"],
  ["insert into tokens (network_id, address, token_key) values (1,'0xaa','0xaa')"],
  ["insert into holdings (handle, network_id, token_key, captured_at, human_amount, source) values ('a',1,'0xaa',?,5,'chain')", ago(2)],
  ["insert into token_info (network_id, token_key, source, fetched_at, security_fetched_at) values (1,'0xaa','gmgn',?,?)", ago(100), ago(100)],
  ["insert into token_price_stats (network_id, token_key, ath_usd, ath_at, last_usd, last_at, drawdown_share) values (1,'0xaa',9,?,6,?,0)", ago(1), ago(1)],
  ["insert into trades (trade_id, handle, network_id, token_address, token_key, token_symbol, status, amount, captured_at) values ('t1','a',1,'0xaa','0xaa','AA','closed',1,?)", ago(3)],
  ["insert into wallet_swaps (network_id, tx_hash, address_key, block_time, token_key, token_delta, quote_usd) values (1,'s1','0xwa',?,'0xaa',1,-2)", ago(1)],
  ["insert into transactions (network_id, tx_hash, address_key, block_time, direction, token_key, amount, source, transfer_key) values (1,'x1','0xwa',?,'in','0xaa',1,'t','k1')", ago(1)],
  ["insert into aum_samples (handle, at, total_usd, basis, tier, sampled_at) values ('a',?,10,'sampled','verified',?)", SAMPLED_AT, SAMPLED_AT],
  ["insert into aum_chain_samples (handle, at, basis, network_id, total_usd) values ('a',?,'sampled',1,10)", SAMPLED_AT],
  ["insert into aum_history (handle, hour, total_usd, basis) values ('a',?,10,'priced')", ago(1)],
  ["insert into aum_live (handle, at, total_usd, source) values ('a',?,10,'webhook')", ago(9)],
];

const health = (): Promise<Response> => handle(new Request("https://test.local/v2/health"));
const healthBody = async (): Promise<unknown> => (await health()).json();
/** Every path in `value` that is null. */
const nulls = (value: unknown, path: string): string[] => value === null ? [path]
  : typeof value === "object" ? Object.entries(value as object).flatMap(([k, v]) => nulls(v, `${path}.${k}`)) : [];

Deno.test("openapi: before the first snapshot /health is the 503 the spec publishes, Retry-After 60 and a database that answers", async () => {
  const res = await health();
  const body = await res.json() as { error: { database: unknown } };
  assertEquals([res.status, res.headers.get("retry-after"), violations(body, schemas.Error, "$")], [503, "60", []]);
  assertEquals(Object.keys(body.error.database as object), ["answering", "latencyMs"]);
});

Deno.test("openapi: the /health body the code emits is the HealthReport the spec publishes, fresh and with the scheduler stopped", async () => {
  for (const [text, ...args] of SEED) db.prepare(text).run(...args);
  await refreshHealthSnapshot();
  const fresh = await healthBody();
  assertEquals(violations(fresh, schemas.HealthReport, "$"), []);
  /** `rowCount` is null by design on every feed but aum, and chains nobody sampled have no accepted reading. */
  assertEquals(nulls(fresh, "$").filter((p) => !/\.rowCount$|\.chains\.(?!ethereum\.)/.test(p)), []);
  db.exec("update health_snapshot set computed_at = '2026-09-01T00:00:00.000Z'");
  const aged = await healthBody() as { staleFeeds: string[] };
  assertEquals(aged.staleFeeds.includes("scheduler"), true);
  assertEquals(violations(aged, schemas.HealthReport, "$"), []);
});

Deno.test("openapi: the /health example is itself a HealthReport", () => {
  const get = spec.paths["/v1/health"].get as { responses: Record<string, { content: Record<string, { example: unknown }> }> };
  assertEquals(violations(get.responses["200"].content["application/json"].example, schemas.HealthReport, "$"), []);
});

Deno.test("openapi: staleFeeds publishes exactly the words /fields does", () => {
  const items = (resolve(schemas.HealthReport).properties as Record<string, Schema>).staleFeeds.items as Schema;
  assertEquals([...(items.enum as string[])].sort(), [...VOCABULARY.fields["health.staleFeeds[]"]].sort());
});

Deno.test("handoff: the spec the app team holds is this spec, and its word list is this vocabulary", async () => {
  assertEquals(await read("../docs/consumer/v2-handoff/openapi.yaml") === specText, true, "cp docs/openapi.yaml docs/consumer/v2-handoff/openapi.yaml");
  const words = JSON.parse(await read(`../docs/consumer/v2-handoff/fields-v${VOCABULARY.version}.json`));
  assertEquals(words.vocabulary, JSON.parse(JSON.stringify(VOCABULARY)));
});
