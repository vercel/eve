import assert from "node:assert/strict";
import { test } from "node:test";

import { getAuthMode, MIN_PASSWORD_LENGTH, unconfiguredReason } from "./setup.ts";

test("a short password leaves the app unconfigured, in development too", () => {
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = "development";
  env.EVE_COMPUTER_USE_PASSWORD = "short";
  assert.equal(getAuthMode(), "unconfigured");
  delete env.EVE_COMPUTER_USE_PASSWORD;
  assert.equal(getAuthMode(), "local-dev");
});

test("a short password leaves a deployment unconfigured, and says why", () => {
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = "production";
  env.EVE_COMPUTER_USE_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH - 1);
  assert.equal(getAuthMode(), "unconfigured");
  assert.match(unconfiguredReason(), /shorter than 16/);
  env.EVE_COMPUTER_USE_PASSWORD = "x".repeat(MIN_PASSWORD_LENGTH);
  assert.equal(getAuthMode(), "password");
  delete env.EVE_COMPUTER_USE_PASSWORD;
  assert.equal(getAuthMode(), "unconfigured");
  assert.match(unconfiguredReason(), /not set/);
});
