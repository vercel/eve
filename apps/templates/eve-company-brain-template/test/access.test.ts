import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticateDevelopmentHttp, canReadModels } from "../agent/lib/access.ts";

const env = {
  SLACK_TEAM_ID: "T_ALICE",
  SLACK_ALLOWED_USER_IDS: " U_ALICE, U_BOB ",
  SLACK_ALLOWED_CHANNEL_IDS: "C_ANALYTICS,D_ALICE",
};

test("model access requires the configured workspace, user, and conversation", () => {
  const alice = {
    authenticator: "slack-webhook",
    principalId: "slack:T_ALICE:U_ALICE",
    attributes: { channel_id: "C_ANALYTICS" },
  };
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

test("a synthetic development identity cannot bypass model allowlists", () => {
  const auth = { authenticator: "local-dev", principalId: "local-dev", attributes: {} };
  assert.equal(canReadModels(auth, { EVE_DEV: "1" }), false);
  assert.equal(canReadModels(auth, { VERCEL: "1", VERCEL_ENV: "development" }), false);
  assert.equal(canReadModels(auth, { VERCEL: "1", VERCEL_ENV: "production" }), false);
  assert.equal(canReadModels(auth, {}), false);
});

test("HTTP model access requires operator credentials and a development server", () => {
  const development = { EVE_DEV: "1", COMPANY_BRAIN_HTTP_PASSWORD: "test-password" };
  const request = (username: string, password: string) =>
    new Request("https://forwarded.example/eve/v1/info", {
      headers: {
        authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      },
    });
  const authenticated = authenticateDevelopmentHttp(
    request("company-brain", "test-password"),
    development,
  );
  assert.ok(authenticated);
  assert.equal(canReadModels(authenticated, development), true);

  for (const unauthenticated of [
    new Request("https://forwarded.example/eve/v1/info"),
    new Request("https://forwarded.example/eve/v1/info", {
      headers: { "x-forwarded-for": "127.0.0.1", host: "localhost" },
    }),
    request("company-brain", "wrong-password"),
    request("someone-else", "test-password"),
  ]) {
    const auth = authenticateDevelopmentHttp(unauthenticated, development);
    assert.equal(auth, null);
    assert.equal(canReadModels(auth, development), false);
  }

  for (const disabled of [
    { EVE_DEV: "1" },
    { EVE_DEV: "1", COMPANY_BRAIN_HTTP_PASSWORD: "" },
    { COMPANY_BRAIN_HTTP_PASSWORD: "test-password" },
    { VERCEL: "1", VERCEL_ENV: "production", COMPANY_BRAIN_HTTP_PASSWORD: "test-password" },
  ]) {
    assert.equal(
      authenticateDevelopmentHttp(request("company-brain", "test-password"), disabled),
      null,
    );
    assert.equal(canReadModels(authenticated, disabled), false);
  }
  assert.equal(authenticateDevelopmentHttp(request("company-brain", ""), { EVE_DEV: "1" }), null);
});
