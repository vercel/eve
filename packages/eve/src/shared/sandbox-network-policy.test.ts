import { describe, expect, it } from "vitest";

import { isSandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";

describe("isSandboxNetworkPolicy", () => {
  it.each(["allow-all", "deny-all"])("accepts %s", (policy) => {
    expect(isSandboxNetworkPolicy(policy)).toBe(true);
  });

  it("accepts domain, subnet, matcher, transform, and forwarding rules", () => {
    expect(
      isSandboxNetworkPolicy({
        allow: {
          "api.example.com": [
            {
              match: {
                headers: [{ key: { exact: "authorization" } }],
                method: ["POST"],
                path: { startsWith: "/v1/" },
              },
              transform: [{ headers: { authorization: "Bearer secret" } }],
            },
          ],
          "proxy.example.com": [{ forwardURL: "https://proxy.example.com" }],
        },
        subnets: { allow: ["10.0.0.0/8"], deny: ["10.1.0.0/16"] },
      }),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    "invalid",
    { allow: [1] },
    { allow: { "api.example.com": [{}] } },
    { allow: { "api.example.com": [{ forwardURL: 1 }] } },
    { allow: { "api.example.com": [{ forwardURL: "https://proxy", transform: [] }] } },
    { allow: { "api.example.com": [{ match: { path: {} }, transform: [] }] } },
    { allow: { "api.example.com": [{ transform: [{ headers: { authorization: 1 } }] }] } },
    { extra: true },
    { subnets: { allow: [1] } },
  ])("rejects malformed policy %#", (policy) => {
    expect(isSandboxNetworkPolicy(policy)).toBe(false);
  });
});
