import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorInstallationRequiredError,
  UserAuthorizationRequiredError,
  type ConnectTokenParams,
} from "@vercel/connect";

import {
  connectUserAuthorization,
  type ConnectUserClient,
} from "../../extension/lib/connect-user-auth.ts";

const DETAILS = [
  { type: "github_app_installation" as const, org: "vercel", repositories: ["eve"] },
];
const USER = { type: "user" as const, id: "U123", issuer: "https://slack.com" };
const CONNECTION = { url: "" };
const PARAMS: ConnectTokenParams = {
  authorizationDetails: DETAILS,
  subject: { type: "user", id: "U123", issuer: "https://slack.com" },
};

function client(overrides: Partial<ConnectUserClient> = {}) {
  const calls: {
    method: string;
    connector: string;
    params: ConnectTokenParams;
    options?: unknown;
  }[] = [];
  const value: ConnectUserClient = {
    async getTokenResponse(connector, params) {
      calls.push({ method: "getTokenResponse", connector, params });
      return {
        token: "user-token",
        expiresAt: 1,
        connector: { id: "c", uid: connector, type: "github" },
      };
    },
    async startAuthorization(connector, params, options) {
      calls.push({ method: "startAuthorization", connector, params, options });
      return {
        request: "r",
        verifier: "v",
        url: "https://connect.example/authorize",
        deviceCode: "ABCD",
        expiresAt: 0,
        connector: { id: "c", uid: connector, type: "github", serviceName: "GitHub", name: "bot" },
      };
    },
    deleteTokenCacheEntry(connector, params) {
      calls.push({ method: "deleteTokenCacheEntry", connector, params });
    },
    ...overrides,
  };
  return { calls, value };
}

test("requests the caller's token scoped to the declared repository", async () => {
  const { calls, value } = client();
  const auth = connectUserAuthorization("github/acme-bot", DETAILS, value);
  assert.equal(auth.principalType, "user");
  assert.deepEqual(auth.vercelConnect, { connector: "github/acme-bot" });

  assert.deepEqual(await auth.getToken({ principal: USER, connection: CONNECTION }), {
    token: "user-token",
    expiresAt: 1,
  });
  const started = await auth.startAuthorization({
    principal: USER,
    connection: CONNECTION,
    callbackUrl: "https://agent.example/callback",
  });
  assert.deepEqual(started.challenge, {
    url: "https://connect.example/authorize",
    userCode: "ABCD",
    displayName: "GitHub",
  });
  await auth.evict?.({ principal: USER, connection: CONNECTION });

  assert.deepEqual(calls, [
    { method: "getTokenResponse", connector: "github/acme-bot", params: PARAMS },
    {
      method: "startAuthorization",
      connector: "github/acme-bot",
      params: PARAMS,
      options: { callbackUrl: "https://agent.example/callback", deviceCode: true },
    },
    { method: "deleteTokenCacheEntry", connector: "github/acme-bot", params: PARAMS },
  ]);
});

test("maps Connect errors to eve authorization errors", async () => {
  const missingGrant = connectUserAuthorization(
    "github/acme-bot",
    DETAILS,
    client({
      async getTokenResponse() {
        throw new UserAuthorizationRequiredError("sign in");
      },
    }).value,
  );
  await assert.rejects(missingGrant.getToken({ principal: USER, connection: CONNECTION }), {
    name: "ConnectionAuthorizationRequiredError",
  });
  await assert.rejects(
    missingGrant.completeAuthorization({
      principal: USER,
      connection: CONNECTION,
      callbackUrl: "https://agent.example/callback",
      callback: { params: {}, method: "GET" },
    }),
    { name: "ConnectionAuthorizationFailedError" },
  );

  const notInstalled = connectUserAuthorization(
    "github/acme-bot",
    DETAILS,
    client({
      async getTokenResponse() {
        throw new ConnectorInstallationRequiredError("install");
      },
    }).value,
  );
  await assert.rejects(notInstalled.getToken({ principal: USER, connection: CONNECTION }), {
    name: "ConnectionAuthorizationFailedError",
    reason: "connector_installation_required",
    retryable: false,
  });
});
