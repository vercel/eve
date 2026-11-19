import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { getAppPassword } from "./password-auth.ts";
import { countInWindow } from "./rate-limit.ts";

/*
 * A proof-of-work step before sign-in, required only while the deployment sees many failed
 * attempts; see the login route. Solving one takes a browser a few seconds, so a correct password
 * always still gets in, while every guess, from any address, costs the same work.
 */

/** Leading zero bits a solution's hash needs: about a million SHA-256 hashes to find. */
export const CHALLENGE_BITS = 20;
const CHALLENGE_TTL_SECONDS = 120;

/** A signed challenge: `<expiry>.<nonce>.<signature>`. */
export function createChallenge(now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + CHALLENGE_TTL_SECONDS}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${sign(payload)}`;
}

/** Whether `solution` solves `challenge`, which this app signed, hasn't expired, and wasn't used. */
export async function verifyChallenge(
  challenge: string,
  solution: string,
  now = Date.now(),
): Promise<boolean> {
  const [expiresAt, nonce, signature, ...extra] = challenge.split(".");
  if (expiresAt === undefined || nonce === undefined || signature === undefined || extra.length > 0)
    return false;
  const expected = Buffer.from(sign(`${expiresAt}.${nonce}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  if (!(Number(expiresAt) > Math.floor(now / 1000))) return false;
  if (!/^\d{1,12}$/.test(solution)) return false;
  if (
    leadingZeroBits(createHash("sha256").update(`${challenge}:${solution}`).digest()) <
    CHALLENGE_BITS
  )
    return false;
  // Each challenge works once, so solving one can't pay for many guesses. The count outlives the
  // challenge, so it can't reset while the challenge is still valid.
  const uses = await countInWindow({
    key: nonce,
    prefix: "login-challenge",
    windowSeconds: 24 * 60 * 60,
  });
  return uses === 1;
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

function sign(payload: string): string {
  return createHmac("sha256", `challenge:${getAppPassword()}`).update(payload).digest("base64url");
}
