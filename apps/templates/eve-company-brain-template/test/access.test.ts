import assert from "node:assert/strict";
import { test } from "node:test";
import { canReadModels } from "../agent/lib/access.ts";

const env = {
  SLACK_TEAM_ID: "T_ALICE",
  SLACK_ALLOWED_USER_IDS: " U_ALICE, U_BOB ",
  SLACK_ALLOWED_CHANNEL_IDS: "C_ANALYTICS,D_ALICE",
};

test("model access requires the configured workspace, user, and conversation", () => {
  const alice = { principalId: "slack:T_ALICE:U_ALICE", attributes: { channel_id: "C_ANALYTICS" } };
  assert.equal(canReadModels(alice, env), true);
  assert.equal(canReadModels({ ...alice, attributes: { channel_id: "D_ALICE" } }, env), true);
  for (const auth of [
    null,
    { ...alice, principalId: "slack:T_OTHER:U_ALICE" },
    { ...alice, principalId: "slack:T_ALICE:U_EXTERNAL" },
    { ...alice, attributes: { channel_id: "C_OTHER" } },
  ]) {
    assert.equal(canReadModels(auth, env), false);
  }
  for (const field of ["SLACK_TEAM_ID", "SLACK_ALLOWED_USER_IDS", "SLACK_ALLOWED_CHANNEL_IDS"]) {
    assert.equal(canReadModels(alice, { ...env, [field]: "" }), false);
  }
});

test("local model access is unavailable outside a development server", () => {
  const auth = { principalId: "local-dev", attributes: {} };
  assert.equal(canReadModels(auth, { EVE_DEV: "1" }), true);
  assert.equal(canReadModels(auth, { VERCEL: "1", VERCEL_ENV: "development" }), true);
  assert.equal(canReadModels(auth, { VERCEL: "1", VERCEL_ENV: "production" }), false);
  assert.equal(canReadModels(auth, {}), false);
});
