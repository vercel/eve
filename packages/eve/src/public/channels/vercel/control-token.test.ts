import { afterEach, describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createControlToken,
  resolveControlSecret,
  verifyControlToken,
} from "#public/channels/vercel/control-token.js";

const auth: SessionAuthContext = {
  attributes: { team: "acme" },
  authenticator: "test",
  issuer: "test-idp",
  principalId: "user-1",
  principalType: "user",
  subject: "user-1",
};

const secret = "test-control-secret";

afterEach(() => {
  delete process.env.EVE_REALTIME_CONTROL_SECRET;
  delete process.env.AI_GATEWAY_API_KEY;
});

describe("control token", () => {
  it("round-trips the principal and voice session id", async () => {
    const token = await createControlToken({
      auth,
      voiceSessionId: "voice-1",
      ttlSeconds: 600,
      secret,
    });
    const result = await verifyControlToken(token, { secret });

    expect(result).toEqual({ ok: true, auth, voiceSessionId: "voice-1" });
  });

  it("rejects a tampered token", async () => {
    const token = await createControlToken({
      auth,
      voiceSessionId: "voice-1",
      ttlSeconds: 600,
      secret,
    });
    const [prefix, body, sig] = token.split(".");
    const tampered = `${prefix}.${body}x.${sig}`;

    expect(await verifyControlToken(tampered, { secret })).toMatchObject({ ok: false });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createControlToken({
      auth,
      voiceSessionId: "voice-1",
      ttlSeconds: 600,
      secret,
    });
    expect(await verifyControlToken(token, { secret: "other" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired token", async () => {
    const token = await createControlToken({
      auth,
      voiceSessionId: "voice-1",
      ttlSeconds: 1,
      secret,
      now: 1_000_000,
    });
    expect(await verifyControlToken(token, { secret, now: 1_000_000 + 5_000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a missing token", async () => {
    expect(await verifyControlToken(undefined, { secret })).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it("derives a fallback secret from AI_GATEWAY_API_KEY", () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key-123";
    const resolved = resolveControlSecret(undefined, { allowGatewayKeyFallback: true });
    expect(resolved).toBe("eve-realtime-control:gw-key-123");
    expect(resolved).not.toBe("gw-key-123");
  });

  it("does not derive from AI_GATEWAY_API_KEY unless explicitly allowed", () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key-123";
    expect(() => resolveControlSecret()).toThrow(/signing secret/);
  });

  it("prefers EVE_REALTIME_CONTROL_SECRET over the gateway key", () => {
    process.env.AI_GATEWAY_API_KEY = "gw-key-123";
    process.env.EVE_REALTIME_CONTROL_SECRET = "dedicated";
    expect(resolveControlSecret()).toBe("dedicated");
  });

  it("throws when no secret is available", () => {
    expect(() => resolveControlSecret()).toThrow(/signing secret/);
  });
});
