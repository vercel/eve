import { describe, expect, it } from "vitest";

import { resolveModelEndpointStatus } from "./resolve-model-endpoint-status.js";

describe("resolveModelEndpointStatus", () => {
  it("reports an external endpoint without a connectedness claim", () => {
    expect(
      resolveModelEndpointStatus(
        { kind: "external", provider: "anthropic" },
        { apiKey: false, oidc: false },
      ),
    ).toEqual({ kind: "external", provider: "anthropic" });
  });

  it("reports gateway connected via api-key, which outranks oidc", () => {
    expect(
      resolveModelEndpointStatus(
        { kind: "gateway", target: "openai" },
        { apiKey: true, oidc: true },
      ),
    ).toEqual({ kind: "gateway", connected: true, credential: "api-key" });
  });

  it("reports gateway connected via oidc when only the token is present", () => {
    expect(
      resolveModelEndpointStatus(
        { kind: "gateway", target: "openai" },
        { apiKey: false, oidc: true },
      ),
    ).toEqual({ kind: "gateway", connected: true, credential: "oidc" });
  });

  it("reports gateway not connected when neither credential is present", () => {
    expect(
      resolveModelEndpointStatus(
        { kind: "gateway", target: "openai" },
        { apiKey: false, oidc: false },
      ),
    ).toEqual({ kind: "gateway", connected: false });
  });
});
