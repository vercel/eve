import { describe, expect, it } from "vitest";

import {
  resolveGatewayCredential,
  resolveModelEndpointStatus,
} from "./resolve-model-endpoint-status.js";

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

describe("resolveGatewayCredential", () => {
  it("ranks an env-file key first, attributing its location", () => {
    expect(
      resolveGatewayCredential({ apiKeyFile: ".env.local", apiKeyInEnv: true, oidcFile: ".env" }),
    ).toEqual({
      credential: "api-key",
      source: { kind: "env-file", path: ".env.local" },
      shadowedOidc: { file: ".env" },
    });
  });

  it("ranks a shell key over the OIDC token it shadows", () => {
    expect(resolveGatewayCredential({ apiKeyInEnv: true, oidcAvailable: true })).toEqual({
      credential: "api-key",
      source: { kind: "shell" },
      shadowedOidc: {},
    });
  });

  it("falls to oidc only when no key exists anywhere", () => {
    expect(resolveGatewayCredential({ oidcFile: ".env.local" })).toEqual({
      credential: "oidc",
      file: ".env.local",
    });
    expect(resolveGatewayCredential({ oidcAvailable: true })).toEqual({ credential: "oidc" });
  });

  it("resolves nothing when no credential is observable", () => {
    expect(resolveGatewayCredential({})).toBeUndefined();
  });
});
