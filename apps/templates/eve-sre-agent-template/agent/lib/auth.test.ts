import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import {
  createServiceAuth,
  resolveSlackUser,
  type SlackUserAuthLike,
} from "./auth.ts";

function slackUserAuth(
  overrides: Partial<SlackUserAuthLike> = {}
): SlackUserAuthLike {
  return {
    attributes: { team_id: "T123" },
    authenticator: "slack-webhook",
    issuer: "slack:T123",
    principalId: "slack:T123:U123",
    principalType: "user",
    ...overrides,
  };
}

describe("resolveSlackUser", () => {
  it("accepts a human Slack user with a consistent issuer", () => {
    assert.deepEqual(resolveSlackUser(slackUserAuth()), {
      principalId: "slack:T123:U123",
      teamId: "T123",
    });
  });

  it("rejects Slack bot, service, and runtime principals", () => {
    for (const principalType of ["bot", "service", "runtime"]) {
      assert.equal(resolveSlackUser(slackUserAuth({ principalType })), null);
    }
  });

  it("rejects webhook-minted service auth", () => {
    assert.equal(
      resolveSlackUser({
        attributes: {},
        authenticator: "investigate",
        principalId: "webhook-123",
        principalType: "service",
      }),
      null
    );
  });

  it("rejects channel-watch service auth", () => {
    assert.equal(
      resolveSlackUser({
        attributes: {},
        authenticator: "channel-watch",
        principalId: "T123:C456:111.222",
        principalType: "service",
      }),
      null
    );
  });

  it("rejects eve local development auth", () => {
    assert.equal(
      resolveSlackUser({
        attributes: {},
        authenticator: "local-dev",
        principalId: "local-dev",
        principalType: "local-dev",
      }),
      null
    );
    assert.equal(
      resolveSlackUser({
        attributes: {},
        authenticator: "local-dev",
        principalId: "local-dev",
        principalType: "user",
      }),
      null
    );
  });

  it("rejects inconsistent Slack identities", () => {
    assert.equal(resolveSlackUser(slackUserAuth({ attributes: {} })), null);
    assert.equal(
      resolveSlackUser(slackUserAuth({ attributes: { team_id: " " } })),
      null
    );
    assert.equal(
      resolveSlackUser(slackUserAuth({ issuer: "slack:T999" })),
      null
    );
    assert.equal(resolveSlackUser(slackUserAuth({ issuer: undefined })), null);
    assert.equal(resolveSlackUser(slackUserAuth({ principalId: " " })), null);
    assert.equal(
      resolveSlackUser(slackUserAuth({ principalId: undefined })),
      null
    );
  });

  it("rejects absent auth", () => {
    assert.equal(resolveSlackUser(null), null);
    assert.equal(resolveSlackUser(undefined), null);
  });
});

test("createServiceAuth builds a webhook service principal", () => {
  assert.deepEqual(
    createServiceAuth({
      authenticator: "investigate",
      principalId: "request-123",
    }),
    {
      attributes: {},
      authenticator: "investigate",
      principalId: "request-123",
      principalType: "service",
    }
  );
});

test("createServiceAuth builds channel-watch service auth", () => {
  assert.deepEqual(
    createServiceAuth({
      authenticator: "channel-watch",
      principalId: "T123:C456:111.222",
    }),
    {
      attributes: {},
      authenticator: "channel-watch",
      principalId: "T123:C456:111.222",
      principalType: "service",
    }
  );
});
