/**
 * pump.fun's bonding curve, pure: the PDA for a mint and the account decode.
 * Layout and the initial-reserve constant verified live in docs/LAUNCH_METADATA.md.
 */
import { base58Decode, findProgramAddress } from "./solana_pda.mjs";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** Global config `initial_real_token_reserves`: 793,100,000 tokens at 6 decimals. */
export const INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n;
const DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];

export function bondingCurveAddress(mint) {
  return findProgramAddress([new TextEncoder().encode("bonding-curve"), base58Decode(mint)], PUMP_PROGRAM).address;
}

/** Decode a BondingCurve account. Null when the bytes are not one. */
export function decodeCurve(bytes) {
  if (bytes.length < 49 || DISCRIMINATOR.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const real = dv.getBigUint64(24, true);
  const complete = bytes[48] === 1;
  // Graduation zeroes the reserves; a read of 0 there means 100 %, and 1 - 0/x would say so
  // anyway, but clamp so a config change upstream can never publish a progress above 1.
  const progress = complete ? 1 : Math.min(1, Math.max(0, 1 - Number(real) / Number(INITIAL_REAL_TOKEN_RESERVES)));
  return { progress: Number(progress.toFixed(4)), graduated: complete };
}
