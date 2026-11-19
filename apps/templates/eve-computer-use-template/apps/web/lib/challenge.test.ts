import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import { CHALLENGE_BITS, createChallenge, leadingZeroBits, verifyChallenge } from "./challenge.ts";

beforeEach(() => {
  process.env.EVE_COMPUTER_USE_PASSWORD = "correct-horse-battery-1";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
});

function solve(challenge: string): string {
  for (let n = 0; ; n++) {
    const hash = createHash("sha256").update(`${challenge}:${n}`).digest();
    if (leadingZeroBits(hash) >= CHALLENGE_BITS) return String(n);
  }
}

test("a solved challenge lets one attempt through, once", async () => {
  const challenge = createChallenge();
  const solution = solve(challenge);
  assert.equal(await verifyChallenge(challenge, solution), true);
  assert.equal(await verifyChallenge(challenge, solution), false);
});

test("a wrong, tampered, foreign, or expired challenge is refused", async () => {
  const challenge = createChallenge();
  const solution = solve(challenge);
  assert.equal(await verifyChallenge(challenge, String(Number(solution) + 1)), false);
  const [expiresAt, nonce, signature] = challenge.split(".");
  assert.equal(
    await verifyChallenge(`${Number(expiresAt) + 60}.${nonce}.${signature}`, solution),
    false,
  );
  assert.equal(await verifyChallenge(challenge, solution, Date.now() + 3 * 60 * 1000), false);
  process.env.EVE_COMPUTER_USE_PASSWORD = "another-password-entirely";
  assert.equal(await verifyChallenge(challenge, solution), false);
});

test("leadingZeroBits counts across bytes", () => {
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0x10, 0xff])), 19);
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
});
