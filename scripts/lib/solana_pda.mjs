/**
 * Solana program-derived addresses without @solana/web3.js: base58, sha256 and the ed25519
 * "is this point on the curve" test a PDA must fail. Node's crypto covers sha256; the curve
 * arithmetic is 20 lines of BigInt. Used by load_token_launch.mjs for pump.fun's
 * ["bonding-curve", mint] seed.
 */
import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes) {
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
const modPow = (b, e) => { let r = 1n; b %= P; for (; e > 0n; e >>= 1n) { if (e & 1n) r = r * b % P; b = b * b % P; } return r; };
const D = (P - 121665n) * modPow(121666n, P - 2n) % P;

export function isOnCurve(bytes) {
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

/** findProgramAddress: the first bump from 255 down whose hash is off the curve. */
export function findProgramAddress(seeds, programId) {
  const pid = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(pid);
    h.update("ProgramDerivedAddress");
    const out = h.digest();
    if (!isOnCurve(out)) return { address: base58Encode(out), bump };
  }
  throw new Error("no viable bump");
}

/** Self-check: `node scripts/lib/solana_pda.mjs`. The expected PDA is pump.fun's global config. */
if (process.argv[1]?.endsWith("solana_pda.mjs")) {
  const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  if (base58Encode(base58Decode(PUMP)) !== PUMP) throw new Error("base58 round trip");
  if (!isOnCurve(base58Decode(PUMP))) throw new Error("a program id is a real key, on the curve");
  const pda = findProgramAddress([new TextEncoder().encode("global")], PUMP);
  if (pda.address !== "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf") throw new Error(`global PDA ${pda.address}`);
  console.log("ok", pda);
}
