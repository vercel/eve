import { describe, expect, it } from "vitest";

import { isSandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

describe("isSandboxNetworkPolicy", () => {
  it("accepts supported policies", () => {
    expect(isSandboxNetworkPolicy("allow-all")).toBe(true);
    expect(
      isSandboxNetworkPolicy({
        allow: {
          "api.example.com": [
            {
              match: { method: ["GET"], path: { startsWith: "/v1/" } },
              transform: [{ headers: { authorization: "Bearer token" } }],
            },
          ],
        },
        subnets: { deny: ["10.0.0.0/8"] },
      }),
    ).toBe(true);
  });

  it("rejects malformed or unknown policy fields", () => {
    expect(isSandboxNetworkPolicy({ allow: { "api.example.com": [{ transform: {} }] } })).toBe(
      false,
    );
    expect(isSandboxNetworkPolicy({ allow: ["api.example.com"], unexpected: true })).toBe(false);
    expect(isSandboxNetworkPolicy({ subnets: { deny: [10] } })).toBe(false);
  });
});
