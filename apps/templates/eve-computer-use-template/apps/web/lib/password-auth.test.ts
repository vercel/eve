import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  createPasswordSessionToken,
  PASSWORD_SESSION_COOKIE_NAME,
  PASSWORD_SESSION_MAX_AGE,
  getPasswordSessionFromHeaders,
  verifyAppPassword,
  verifyPasswordSessionToken,
} from "./password-auth.ts";

beforeEach(() => {
  process.env.EVE_COMPUTER_USE_PASSWORD = "correct-horse-battery-1";
});

test("the password must match, and an unset password lets no one in", () => {
  assert.equal(verifyAppPassword("correct-horse-battery-1"), true);
  assert.equal(verifyAppPassword("correct-horse-battery-2"), false);
  process.env.EVE_COMPUTER_USE_PASSWORD = "";
  assert.equal(verifyAppPassword(""), false);
});

test("a session token verifies until it expires", () => {
  const now = Date.now();
  const token = createPasswordSessionToken(now);
  assert.equal(verifyPasswordSessionToken(token, now), true);
  assert.equal(
    verifyPasswordSessionToken(token, now + (PASSWORD_SESSION_MAX_AGE + 1) * 1000),
    false,
  );
});

test("a tampered, malformed, or re-keyed token is refused", () => {
  const token = createPasswordSessionToken();
  const [version, expiresAt, signature] = token.split(".");
  assert.equal(
    verifyPasswordSessionToken(`${version}.${Number(expiresAt) + 1}.${signature}`),
    false,
  );
  assert.equal(verifyPasswordSessionToken(`v2.${expiresAt}.${signature}`), false);
  assert.equal(verifyPasswordSessionToken(`${token}.extra`), false);
  assert.equal(verifyPasswordSessionToken(undefined), false);
  process.env.EVE_COMPUTER_USE_PASSWORD = "a-new-password";
  assert.equal(verifyPasswordSessionToken(token), false);
});

test("the session is read from its cookie", () => {
  const cookie = `other=1; ${PASSWORD_SESSION_COOKIE_NAME}=${encodeURIComponent(createPasswordSessionToken())}`;
  assert.equal(getPasswordSessionFromHeaders(new Headers({ cookie })), true);
  assert.equal(getPasswordSessionFromHeaders(new Headers()), false);
});
