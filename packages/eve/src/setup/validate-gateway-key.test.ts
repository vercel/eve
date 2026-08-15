import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createGateway: vi.fn(), getCredits: vi.fn() }));

vi.mock("ai", () => ({
  createGateway: mocks.createGateway.mockReturnValue({ getCredits: mocks.getCredits }),
}));

import { validateGatewayApiKey } from "./validate-gateway-key.js";

describe("validateGatewayApiKey", () => {
  it("is valid when the gateway accepts the key", async () => {
    mocks.getCredits.mockResolvedValueOnce({ models: [] });
    await expect(validateGatewayApiKey("sk-good")).resolves.toEqual({ kind: "valid" });

    // The provider's fetch must send the eve product token on the wire.
    const { fetch: providerFetch } = mocks.createGateway.mock.calls[0]![0] as {
      fetch: typeof globalThis.fetch;
    };
    const inner = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", inner);
    try {
      await providerFetch("https://ai-gateway.vercel.sh/v1/credits", {});
    } finally {
      vi.unstubAllGlobals();
    }
    const [, init] = inner.mock.calls[0]!;
    expect(new Headers(init?.headers).get("user-agent")).toMatch(/^eve\/.+/);
  });

  it("is invalid on an authentication rejection (401 / authentication_error)", async () => {
    mocks.getCredits.mockRejectedValueOnce({
      name: "GatewayAuthenticationError",
      type: "authentication_error",
      statusCode: 401,
    });
    await expect(validateGatewayApiKey("sk-bad")).resolves.toEqual({
      kind: "invalid",
      message: expect.any(String),
    });
  });

  it("is inconclusive on a non-auth failure (offline, timeout)", async () => {
    mocks.getCredits.mockRejectedValueOnce(new Error("network down"));
    const result = await validateGatewayApiKey("sk-x");
    expect(result.kind).toBe("inconclusive");
  });

  it("rethrows when the caller's signal aborted (not a verdict on the key)", async () => {
    const controller = new AbortController();
    controller.abort();
    mocks.getCredits.mockRejectedValueOnce(new Error("aborted"));
    await expect(validateGatewayApiKey("sk-x", controller.signal)).rejects.toThrow();
  });
});
