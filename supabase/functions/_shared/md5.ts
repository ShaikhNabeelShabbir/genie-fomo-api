/**
 * MD5 over UTF-8, hex. Pure, no dependencies.
 *
 * `transactions.transfer_key` was `md5(...)` in Postgres. SQLite has no md5 and the Workers
 * Web Crypto has no MD5 either, so the key is computed here, in TypeScript, from the same
 * expression the migration used — identical inputs must keep producing identical keys.
 * RFC 1321. Not a security primitive: it is a content digest for a primary key.
 */

const S: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(2^32 * abs(sin(i + 1))). */
const K: readonly number[] = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

/** Padded message as little-endian 32-bit words (RFC 1321 §3.1–3.2). */
function words(bytes: Uint8Array): Int32Array {
  const bitLen = bytes.length * 8;
  const out = new Int32Array((((bytes.length + 8) >> 6) + 1) << 4);
  for (let i = 0; i < bytes.length; i++) out[i >> 2] |= bytes[i] << ((i % 4) * 8);
  out[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  out[out.length - 2] = bitLen | 0;
  out[out.length - 1] = Math.floor(bitLen / 4294967296);
  return out;
}

const HEX = "0123456789abcdef";
const hex = (n: number): string => {
  let s = "";
  for (let i = 0; i < 4; i++) {
    const b = (n >>> (i * 8)) & 0xff;
    s += HEX[b >>> 4] + HEX[b & 0x0f];
  }
  return s;
};

/** Lowercase hex MD5 of `input`, encoded UTF-8. */
export function md5(input: string): string {
  const m = words(new TextEncoder().encode(input));
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let chunk = 0; chunk < m.length; chunk += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + K[i] + m[chunk + g]) | 0, S[i])) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

/**
 * What Postgres printed for `$n::numeric::text` when `n` was bound from a JS number: plain
 * decimal, never an exponent. JS only uses exponent form below 1e-6 and from 1e21 up, so
 * expanding those two cases is the whole difference. Keys written before the D1 move must
 * keep matching, or a re-fetched transfer inserts a second row instead of updating one.
 */
export function numericText(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", expText] = m;
  const digits = int + frac;
  const point = int.length + Number(expText);
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * `transactions.transfer_key`: the Postgres expression
 * `md5(coalesce(token_key,'')||'|'||coalesce(direction,'')||'|'||coalesce(counterparty,'')||'|'||coalesce(amount::text,''))`,
 * now computed here because neither SQLite nor the Workers Web Crypto has MD5.
 */
export function transferKey(
  tokenKey: string | null, direction: string | null, counterparty: string | null, amount: number | null,
): string {
  return md5(`${tokenKey ?? ""}|${direction ?? ""}|${counterparty ?? ""}|${amount === null ? "" : numericText(amount)}`);
}
