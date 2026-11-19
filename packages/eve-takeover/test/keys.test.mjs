import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTakeoverKeys,
  mintStreamToken,
  openTakeoverGrant,
  sealTakeoverGrant,
  STREAM_TOKEN_MAX_TTL_MS,
  verifyStreamToken,
} from "@eve/takeover/core";

const SECRET = "a".repeat(32);
const keys = deriveTakeoverKeys(SECRET);
const NOW = 1_800_000_000_000;
const expected = { sessionId: "ses_1", callId: "call_1", now: NOW };
const grant = {
  v: 1,
  sid: "ses_1",
  cid: "call_1",
  requester: { authenticator: "slack", principalType: "user", principalId: "U1", attributes: {} },
  stream: "wss://sb-1.vercel.run/stream",
  protocol: "screencast",
  label: "browser",
  task: "Sign in",
  callback: "https://agent.example/eve/v1/callback/abc",
  exp: NOW + 60_000,
};

test("keys derive from the secret and refuse short secrets", () => {
  assert.equal(deriveTakeoverKeys(SECRET).publicKeySpki, keys.publicKeySpki);
  assert.notEqual(deriveTakeoverKeys("b".repeat(32)).publicKeySpki, keys.publicKeySpki);
  assert.throws(() => deriveTakeoverKeys("short"), /at least 32/);
});

test("stream tokens name one session and call, expire, and cap their lifetime", () => {
  const { token, expiresAt } = mintStreamToken(keys, { ...expected, ttlMs: 30_000 });
  assert.equal(expiresAt, NOW + 30_000);
  assert.ok(verifyStreamToken(keys.publicKeySpki, token, expected));
  assert.equal(verifyStreamToken(keys.publicKeySpki, token, { ...expected, callId: "x" }), null);
  assert.equal(verifyStreamToken(keys.publicKeySpki, token, { ...expected, sessionId: "x" }), null);
  assert.equal(
    verifyStreamToken(keys.publicKeySpki, token, { ...expected, now: NOW + 30_000 }),
    null,
  );
  const other = deriveTakeoverKeys("b".repeat(32));
  assert.equal(verifyStreamToken(other.publicKeySpki, token, expected), null);
  const long = mintStreamToken(keys, { ...expected, ttlMs: 3_600_000 });
  assert.equal(long.expiresAt, NOW + STREAM_TOKEN_MAX_TTL_MS);
});

test("grants round-trip sealed, hide their contents, and reject tampering and expiry", () => {
  const sealed = sealTakeoverGrant(keys, grant);
  assert.deepEqual(openTakeoverGrant(keys, sealed, NOW), { status: "ok", grant });
  const raw = Buffer.from(sealed, "base64url").toString("latin1");
  for (const secret of ["vercel.run", "callback", "U1"]) assert.equal(raw.includes(secret), false);
  assert.deepEqual(openTakeoverGrant(keys, sealed, grant.exp), { status: "expired" });
  const bytes = Buffer.from(sealed, "base64url");
  bytes[bytes.length - 1] ^= 1;
  assert.deepEqual(openTakeoverGrant(keys, bytes.toString("base64url"), NOW), {
    status: "invalid",
  });
  assert.deepEqual(openTakeoverGrant(deriveTakeoverKeys("b".repeat(32)), sealed, NOW), {
    status: "invalid",
  });
  const insecure = sealTakeoverGrant(keys, { ...grant, stream: "ws://evil.example/stream" });
  assert.deepEqual(openTakeoverGrant(keys, insecure, NOW), { status: "invalid" });
});
