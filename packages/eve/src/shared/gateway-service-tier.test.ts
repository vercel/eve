import { describe, expect, it } from "vitest";

import { readGatewayServiceTier } from "./gateway-service-tier.js";

describe("readGatewayServiceTier", () => {
  it("reads the priority tier eve's Fast mode writes", () => {
    expect(readGatewayServiceTier({ gateway: { serviceTier: "priority" } })).toEqual({
      kind: "priority",
    });
  });

  it("surfaces any other authored tier as custom", () => {
    expect(readGatewayServiceTier({ gateway: { serviceTier: "flex" } })).toEqual({
      kind: "custom",
      value: "flex",
    });
  });

  it("treats absent or malformed provider options as standard", () => {
    expect(readGatewayServiceTier(undefined)).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier(null)).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier("priority")).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier([])).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier({})).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier({ gateway: [] })).toEqual({ kind: "standard" });
    expect(readGatewayServiceTier({ gateway: { serviceTier: 3 } })).toEqual({ kind: "standard" });
  });
});
