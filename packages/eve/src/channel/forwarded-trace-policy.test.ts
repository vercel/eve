import { describe, expect, it, vi } from "vitest";

import {
  parseForwardedTracePolicy,
  resolveForwardedTracePolicy,
} from "#channel/forwarded-trace-policy.js";
import type { SessionAuthContext } from "#channel/types.js";

const FORWARDER: SessionAuthContext = {
  attributes: {},
  authenticator: "oidc",
  principalId: "router",
  principalType: "service",
};

describe("parseForwardedTracePolicy", () => {
  it("accepts audience and directional capture policy", () => {
    expect(
      parseForwardedTracePolicy({
        audience: "public",
        decision: { action: "record", recordInputs: true, recordOutputs: false },
      }),
    ).toEqual({
      audience: "public",
      decision: { action: "record", recordInputs: true, recordOutputs: false },
    });
  });

  it.each([
    undefined,
    { audience: "everyone" },
    { audience: "public", decision: { action: "record", recordInputs: true } },
    { audience: "public", token: "secret" },
  ])("rejects malformed policy %#", (value) => {
    expect(parseForwardedTracePolicy(value)).toBeUndefined();
  });
});

describe("resolveForwardedTracePolicy", () => {
  it("requires the trusted-forwarder policy", async () => {
    const trustedForwarders = vi.fn(() => true);
    const payload = { forwardedTracePolicy: { audience: "public" } };

    await expect(
      resolveForwardedTracePolicy({
        forwarder: FORWARDER,
        payload,
        trustedForwarders,
      }),
    ).resolves.toEqual({ audience: "public" });
    await expect(
      resolveForwardedTracePolicy({
        forwarder: FORWARDER,
        payload,
        trustedForwarders: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the forwarder is refused or the policy throws", async () => {
    await expect(
      resolveForwardedTracePolicy({
        forwarder: FORWARDER,
        payload: { forwardedTracePolicy: { audience: "public" } },
        trustedForwarders: () => false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveForwardedTracePolicy({
        forwarder: FORWARDER,
        payload: { forwardedTracePolicy: { audience: "public" } },
        trustedForwarders: () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
