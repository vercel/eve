import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { authorizeRemoteCallback } from "#eve-channel/remote-callback-policy.js";

const forwarder: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "router",
  principalType: "service",
};

function authorize(input: {
  body?: { activityObserver?: unknown; callback?: unknown };
  forwarderTrusted?: boolean;
  trustedForwarders?: (forwarder: SessionAuthContext) => boolean | Promise<boolean>;
}) {
  return authorizeRemoteCallback({
    body: input.body ?? { callback: {} },
    forwarder,
    forwarderTrusted: input.forwarderTrusted ?? false,
    trustedForwarders: input.trustedForwarders,
  });
}

describe("authorizeRemoteCallback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores requests without a callback destination", async () => {
    await expect(authorize({ body: {} })).resolves.toBeNull();
    await expect(authorize({ body: {}, trustedForwarders: () => false })).resolves.toBeNull();
  });

  it("rejects callback work when no trustedForwarders policy exists", async () => {
    const response = await authorize({});
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({ ok: false });

    const observer = await authorize({ body: { activityObserver: {} } });
    expect(observer?.status).toBe(403);
  });

  it("rejects callers the policy does not accept", async () => {
    const trustedForwarders = vi.fn(() => false);
    const response = await authorize({ trustedForwarders });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Caller is not authorized to delegate work with a callback to this deployment.",
      ok: false,
    });
    expect(trustedForwarders).toHaveBeenCalledWith(forwarder);
  });

  it("accepts callers the policy accepts", async () => {
    await expect(authorize({ trustedForwarders: () => true })).resolves.toBeNull();
    await expect(
      authorize({ body: { activityObserver: {} }, trustedForwarders: async () => true }),
    ).resolves.toBeNull();
  });

  it("does not re-evaluate a policy that already trusted the forwarder", async () => {
    const trustedForwarders = vi.fn(() => false);
    await expect(authorize({ forwarderTrusted: true, trustedForwarders })).resolves.toBeNull();
    expect(trustedForwarders).not.toHaveBeenCalled();
  });

  it("returns 500 without leaking the policy failure", async () => {
    const response = await authorize({
      trustedForwarders: () => {
        throw new Error("secret detail");
      },
    });
    expect(response?.status).toBe(500);
    const body = (await response?.json()) as { error: string; errorId: string };
    expect(body.error).toBe("trustedForwarders handler failed.");
    expect(body.error).not.toContain("secret detail");
    expect(typeof body.errorId).toBe("string");
  });

  it("exempts local eve dev outside Vercel only", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("VERCEL", "");
    await expect(authorize({})).resolves.toBeNull();

    vi.stubEnv("VERCEL", "1");
    const response = await authorize({});
    expect(response?.status).toBe(403);
  });
});
