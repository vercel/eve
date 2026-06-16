import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getCredits: vi.fn() }));

vi.mock("ai", () => ({
  createGateway: () => ({ getCredits: mocks.getCredits }),
}));

import { validateGatewayApiKey } from "./validate-gateway-key.js";

describe("validateGatewayApiKey", () => {
  it("is valid when the gateway accepts the key", async () => {
    mocks.getCredits.mockResolvedValueOnce({ models: [] });
    await expect(validateGatewayApiKey("sk-good")).resolves.toEqual({ kind: "valid" });
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
