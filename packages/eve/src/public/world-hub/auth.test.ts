import { describe, expect, it } from "vitest";
import { signWorldHubRequest, verifyWorldHubRequest } from "./auth.js";
describe("World hub HMAC", () => {
  it("validates signatures and rejects tampering and skew", () => {
    const now = Date.now();
    const headers = new Headers(
      signWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", String(now)),
    );
    expect(verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", headers, now)).toBe(
      true,
    );
    expect(verifyWorldHubRequest("wrong", "POST", "/world/v1/rpc", "body", headers, now)).toBe(
      false,
    );
    expect(verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "tampered", headers, now)).toBe(
      false,
    );
    expect(
      verifyWorldHubRequest("secret", "POST", "/world/v1/rpc", "body", headers, now + 300001),
    ).toBe(false);
    expect(verifyWorldHubRequest("secret", "GET", "/world/v1/rpc", "body", headers, now)).toBe(
      false,
    );
  });
});
