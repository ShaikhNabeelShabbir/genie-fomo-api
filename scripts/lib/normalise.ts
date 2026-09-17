// Acceptance-capture normaliser: the pure twin of the jq filter the capture used to run.
// Strips the fields the API documents as live, folds `/v2/` links back to `/v1/`, and renders
// the result the way `jq -S` does so two captures diff byte for byte.

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

const LIVE_KEY = /[aA]geSeconds$|^requestId$|^requestedFrom$|^pipelineLastSuccessAt$/;
const ISO_PREFIX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/;

export const isJsonObject = (value: Json): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Window bounds are computed from the request clock; a `from`/`to` that is an address stays.
const isLiveEntry = (key: string, value: Json): boolean =>
  LIVE_KEY.test(key) ||
  ((key === "from" || key === "to") && typeof value === "string" && ISO_PREFIX.test(value));

const walk = (value: Json): Json => {
  if (typeof value === "string") return value.replaceAll("/v2/", "/v1/");
  if (Array.isArray(value)) return value.map(walk);
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(([key, v]) => !isLiveEntry(key, v)).map(([key, v]) => [key, walk(v)]),
    );
  }
  return value;
};

// `asOf` and `liveRead` go only at the top level, as the jq filter did.
export const normalise = (value: Json): Json =>
  isJsonObject(value)
    ? walk(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "asOf" && key !== "liveRead")))
    : walk(value);

// jq escapes DEL; JSON.stringify leaves it raw.
const renderString = (s: string): string => JSON.stringify(s).replaceAll("\x7f", "\\u007f");
// jq 1.7 prints exponents as `1E-7`; JS as `1e-7`. Digits agree because the API's numbers are
// JS-canonical already. ponytail: a `1.0` literal from a non-JS source would render as `1`.
const renderNumber = (n: number): string => String(n).replace("e", "E");

const renderValue = (value: Json, indent: string): string => {
  if (typeof value === "string") return renderString(value);
  if (typeof value === "number") return renderNumber(value);
  if (value === null || typeof value === "boolean") return String(value);
  const inner = `${indent}  `;
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((k) => `${inner}${renderString(k)}: ${renderValue(value[k], inner)}`).join(",\n")}\n${indent}}`;
  }
  if (value.length === 0) return "[]";
  return `[\n${value.map((v) => inner + renderValue(v, inner)).join(",\n")}\n${indent}]`;
};

// `jq -S .`: two-space indent, keys sorted at every depth, trailing newline.
export const render = (value: Json): string => `${renderValue(value, "")}\n`;

// `jq -S keys`: the sorted top-level key list, for the health capture.
export const renderKeys = (value: JsonObject): string => render(Object.keys(value).sort());
