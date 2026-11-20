import assert from "node:assert/strict";
import { test } from "node:test";

import { getAuthMode, unconfiguredReason } from "./setup.ts";

const env = process.env as Record<string, string | undefined>;
const SECRET = "0ESL6BM0HXd9bMmtR7aDx0NE3QxsR8K2d5y8oFsf";

test("only a generated secret turns on password mode", () => {
  env.NODE_ENV = "production";
  env.EVE_COMPUTER_USE_PASSWORD = SECRET;
  assert.equal(getAuthMode(), "password");
  for (const weak of [
    "correct-horse-battery-1",
    "a".repeat(64),
    "abcabcabcabcabcabcabcabcabcabcab",
  ]) {
    env.EVE_COMPUTER_USE_PASSWORD = weak;
    assert.equal(getAuthMode(), "unconfigured", weak);
    assert.match(unconfiguredReason(), /generated secret/);
  }
  delete env.EVE_COMPUTER_USE_PASSWORD;
  assert.equal(getAuthMode(), "unconfigured");
  assert.match(unconfiguredReason(), /not set/);
});

test("a weak password leaves the app unconfigured in development too", () => {
  env.NODE_ENV = "development";
  env.EVE_COMPUTER_USE_PASSWORD = "short";
  assert.equal(getAuthMode(), "unconfigured");
  delete env.EVE_COMPUTER_USE_PASSWORD;
  assert.equal(getAuthMode(), "local-dev");
});
