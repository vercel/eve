import { describe, expect, it } from "vitest";

import {
  FORWARDED_BY_ATTRIBUTE,
  parseForwardedAuth,
  stampForwardedBy,
} from "#channel/forwarded-auth.js";
import type { SessionAuthContext } from "#channel/types.js";

function slackUser(overrides: Partial<SessionAuthContext> = {}): SessionAuthContext {
  return {
    attributes: { user_id: "U123" },
    authenticator: "slack-webhook",
    issuer: "slack",
    principalId: "slack:U123",
    principalType: "user",
    subject: "U123",
    ...overrides,
  };
}

describe("parseForwardedAuth", () => {
  it("accepts a current-only payload", () => {
    const result = parseForwardedAuth({ current: slackUser() });

    expect(result).toEqual({ forwardedAuth: { current: slackUser() }, ok: true });
  });

  it("accepts a payload with a distinct initiator", () => {
    const initiator = slackUser({ principalId: "slack:U999", subject: "U999" });
    const result = parseForwardedAuth({ current: slackUser(), initiator });

    expect(result).toEqual({
      forwardedAuth: { current: slackUser(), initiator },
      ok: true,
    });
  });

  it("keeps authenticator and principalType open for channel-produced contexts", () => {
    // The flagship use case: a Slack-authenticated user forwarded by a router
    // deployment. The wire schema must not mirror the runtime enum schema.
    const result = parseForwardedAuth({
      current: {
        attributes: {},
        authenticator: "twilio-webhook",
        principalId: "whatsapp:+15550001111",
        principalType: "anonymous",
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts string-array attribute values", () => {
    const result = parseForwardedAuth({
      current: slackUser({ attributes: { groups: ["eng", "ops"], team: "T1" } }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forwardedAuth.current.attributes).toEqual({
        groups: ["eng", "ops"],
        team: "T1",
      });
    }
  });

  it("omits absent optional fields instead of writing undefined", () => {
    const result = parseForwardedAuth({
      current: {
        attributes: {},
        authenticator: "jwt-hmac",
        principalId: "user-1",
        principalType: "user",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.forwardedAuth.current)).not.toContain("issuer");
      expect(Object.keys(result.forwardedAuth.current)).not.toContain("subject");
    }
  });

  it.each([
    ["a non-object", "forwarded"],
    ["null", null],
    ["an array", [slackUser()]],
  ])("rejects %s payload", (_label, value) => {
    const result = parseForwardedAuth(value);

    expect(result.ok).toBe(false);
  });

  it("rejects a payload without current", () => {
    const result = parseForwardedAuth({ initiator: slackUser() });

    expect(result).toMatchObject({
      message: expect.stringContaining("forwardedAuth.current"),
      ok: false,
    });
  });

  it("rejects unknown keys at the top level", () => {
    const result = parseForwardedAuth({ current: slackUser(), token: "secret" });

    expect(result).toMatchObject({
      message: expect.stringContaining("Invalid forwardedAuth metadata"),
      ok: false,
    });
  });

  it("rejects unknown keys inside a context", () => {
    const result = parseForwardedAuth({ current: { ...slackUser(), credential: "secret" } });

    expect(result).toMatchObject({
      message: expect.stringContaining("forwardedAuth.current"),
      ok: false,
    });
  });

  it("rejects an empty principalId", () => {
    const result = parseForwardedAuth({ current: slackUser({ principalId: "" }) });

    expect(result).toMatchObject({
      message: expect.stringContaining("forwardedAuth.current.principalId"),
      ok: false,
    });
  });

  it("rejects non-string attribute values", () => {
    const result = parseForwardedAuth({
      current: slackUser({ attributes: { count: 3 } as never }),
    });

    expect(result.ok).toBe(false);
  });
});

describe("stampForwardedBy", () => {
  it("records the transport caller as an attribute", () => {
    const stamped = stampForwardedBy(slackUser(), "router-app");

    expect(stamped.attributes[FORWARDED_BY_ATTRIBUTE]).toBe("router-app");
    expect(stamped.attributes.user_id).toBe("U123");
    expect(stamped.principalId).toBe("slack:U123");
  });

  it("overwrites a sender-supplied forwarded-by value", () => {
    const forged = slackUser({
      attributes: { [FORWARDED_BY_ATTRIBUTE]: "someone-else" },
    });

    const stamped = stampForwardedBy(forged, "router-app");

    expect(stamped.attributes[FORWARDED_BY_ATTRIBUTE]).toBe("router-app");
  });

  it("does not mutate the input context", () => {
    const original = slackUser();

    stampForwardedBy(original, "router-app");

    expect(original.attributes[FORWARDED_BY_ATTRIBUTE]).toBeUndefined();
  });
});
