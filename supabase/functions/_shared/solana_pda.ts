/**
 * Solana program-derived addresses without @solana/web3.js: base58, sha256 and the ed25519
 * "is this point on the curve" test a PDA must fail. TWIN OF scripts/lib/solana_pda.mjs: edit
 * both. Differs only in sha256: `crypto.subtle` (async) instead of node:crypto.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

// ed25519: p = 2^255 - 19, d = -121665/121666. A 32-byte string is a valid public key iff
// x^2 = (y^2 - 1) / (d y^2 + 1) has a square root mod p.
const P = 2n ** 255n - 19n;
const modPow = (b: bigint, e: bigint): bigint => { let r = 1n; b %= P; for (; e > 0n; e >>= 1n) { if (e & 1n) r = r * b % P; b = b * b % P; } return r; };
const D = (P - 121665n) * modPow(121666n, P - 2n) % P;

export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = y * 256n + BigInt(bytes[i]);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = y * y % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x = u * modPow(v, 3n) % P * modPow(u * modPow(v, 7n) % P, (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  return vx2 === u || vx2 === (P - u) % P;
}

export interface Pda { readonly address: string; readonly bump: number }

/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export async function findProgramAddress(seeds: readonly Uint8Array[], programId: string): Promise<Pda> {
  const pid = base58Decode(programId);
  const tail = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), pid, tail];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { buf.set(p, off); off += p.length; }
    const out = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no viable bump");
}
