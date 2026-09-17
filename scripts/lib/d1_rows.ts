// Pure row conversion for the Postgres CSV -> D1 (SQLite) import; scripts/csv_to_d1.ts streams
// the files and calls these. Type map: docs/D1_MIGRATION.md "Import".

export interface Column {
  readonly name: string;
  readonly type: string;
}

export type Cell = string | number | null;

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

const isoOffset = (zone: string): string => {
  if (zone === "Z" || zone.includes(":")) return zone;
  return zone.length === 3 ? `${zone}:00` : `${zone.slice(0, 3)}:${zone.slice(3)}`;
};

/** `2026-09-17 04:25:11.123456+05:30` -> `2026-09-16T22:55:11.123Z`; no zone means UTC. */
export const toIsoUtc = (text: string): string => {
  const match = TIMESTAMP.exec(text);
  if (!match) throw new TypeError(`not a Postgres timestamp: ${JSON.stringify(text)}`);
  const [, day, clock, fraction = "", zone = "Z"] = match;
  const millis = fraction === "" ? "" : fraction.padEnd(4, "0").slice(0, 4);
  const date = new Date(`${day}T${clock}${millis}${isoOffset(zone)}`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid timestamp: ${JSON.stringify(text)}`);
  return date.toISOString();
};

const toReal = (text: string): number => {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) {
    throw new TypeError(`not a finite number: ${JSON.stringify(text)}`);
  }
  return value;
};

const toInteger = (text: string): number => {
  if (!/^-?\d+$/.test(text)) throw new TypeError(`not an integer: ${JSON.stringify(text)}`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`integer exceeds 2^53, precision would be lost: ${text}`);
  }
  return value;
};

const toBoolean = (text: string): number => {
  if (text === "t" || text === "true") return 1;
  if (text === "f" || text === "false") return 0;
  throw new TypeError(`not a Postgres boolean: ${JSON.stringify(text)}`);
};

/** Postgres array literal `{a,"b c",NULL}` -> `["a","b c",null]`. One level; nothing here nests. */
export const parsePgArray = (text: string): (string | null)[] => {
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new TypeError(`not a Postgres array: ${JSON.stringify(text)}`);
  }
  const body = text.slice(1, -1);
  if (body === "") return [];
  const out: (string | null)[] = [];
  let i = 0;
  while (true) {
    if (body[i] === '"') {
      let item = "";
      i += 1;
      while (i < body.length && body[i] !== '"') {
        if (body[i] === "\\") i += 1;
        item += body[i];
        i += 1;
      }
      if (body[i] !== '"') throw new TypeError(`unterminated quote in array: ${JSON.stringify(text)}`);
      i += 1;
      out.push(item);
    } else {
      const end = body.indexOf(",", i);
      const raw = body.slice(i, end === -1 ? body.length : end);
      out.push(raw === "NULL" ? null : raw);
      i = end === -1 ? body.length : end;
    }
    if (i >= body.length) return out;
    if (body[i] !== ",") throw new TypeError(`expected , at ${i} in array: ${JSON.stringify(text)}`);
    i += 1;
  }
};

/** One CSV field under one Postgres type. `null` (an empty unquoted CSV field) stays null. */
export const convertCell = (text: string | null, type: string): Cell => {
  if (text === null) return null;
  const kind = type.toLowerCase();
  if (kind.startsWith("timestamp")) return toIsoUtc(text);
  if (kind === "numeric" || kind === "decimal" || kind === "double precision" || kind === "real") {
    return toReal(text);
  }
  if (kind === "bigint" || kind === "integer" || kind === "smallint") return toInteger(text);
  if (kind === "boolean") return toBoolean(text);
  if (kind === "array" || kind.endsWith("[]")) return JSON.stringify(parsePgArray(text));
  return text; // date, text, uuid, json, jsonb: the Postgres text form is already the SQLite one
};

export const convertRow = (fields: readonly (string | null)[], columns: readonly Column[]): Cell[] => {
  if (fields.length !== columns.length) {
    throw new RangeError(`row has ${fields.length} fields, expected ${columns.length}`);
  }
  return fields.map((field, i) => convertCell(field, columns[i].type));
};

const quoteId = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (cell: Cell): string =>
  cell === null ? "NULL" : typeof cell === "number" ? String(cell) : `'${cell.replaceAll("'", "''")}'`;

/** Multi-row inserts, each statement at most `maxBytes` (D1 caps a statement at 100 KB). */
export const insertStatements = (
  table: string,
  columnNames: readonly string[],
  rows: readonly (readonly Cell[])[],
  maxBytes = 90_000,
): string[] => {
  const head = `insert into ${quoteId(table)} (${columnNames.map(quoteId).join(",")}) values `;
  const headBytes = bytes(head);
  const out: string[] = [];
  let tuples: string[] = [];
  let size = headBytes;
  for (const row of rows) {
    const tuple = `(${row.map(literal).join(",")})`;
    const cost = bytes(tuple) + 1; // the separating comma, or the closing semicolon
    if (headBytes + cost > maxBytes) throw new RangeError(`a single ${table} row exceeds ${maxBytes} bytes`);
    if (tuples.length > 0 && size + cost > maxBytes) {
      out.push(`${head}${tuples.join(",")};`);
      tuples = [];
      size = headBytes;
    }
    tuples.push(tuple);
    size += cost;
  }
  if (tuples.length > 0) out.push(`${head}${tuples.join(",")};`);
  return out;
};
