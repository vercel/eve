import { describe, expect, it } from "vitest";

import {
  isSelectedModelProviderConfigured,
  resolveSelectedModelProvider,
  type GatewayProviderState,
} from "./model-provider-state.js";

const competingState: GatewayProviderState = {
  available: {
    gatewayProject: { projectName: "my-agent", teamName: "my-team" },
    gatewayKey: { source: { kind: "shell" } },
  },
  preferredGatewayCredential: "project",
};

describe("model provider state", () => {
  it("derives ChatGPT from authored routing before consulting the Gateway preference", () => {
    expect(
      resolveSelectedModelProvider(competingState, { kind: "external", provider: "codex" }),
    ).toBe("chatgpt");
    expect(isSelectedModelProviderConfigured(competingState, "chatgpt")).toBe(true);
  });

  it("uses the explicit Gateway preference when credentials compete", () => {
    expect(competingState.available.gatewayProject).toBeDefined();
    expect(competingState.available.gatewayKey).toBeDefined();
    expect(
      resolveSelectedModelProvider(competingState, { kind: "gateway", target: "anthropic" }),
    ).toBe("gateway-project");
    expect(isSelectedModelProviderConfigured(competingState, "gateway-project")).toBe(true);
  });

  it("matches API-key-first runtime precedence when no preference exists", () => {
    expect(
      resolveSelectedModelProvider(
        { ...competingState, preferredGatewayCredential: undefined },
        { kind: "gateway", target: "anthropic" },
      ),
    ).toBe("gateway-key");
  });

  it("does not silently change an unavailable explicit Gateway preference", () => {
    const state: GatewayProviderState = {
      available: { gatewayKey: { source: { kind: "shell" } } },
      preferredGatewayCredential: "project",
    };

    expect(resolveSelectedModelProvider(state, { kind: "gateway", target: "anthropic" })).toBe(
      "gateway-project",
    );
    expect(isSelectedModelProviderConfigured(state, "gateway-project")).toBe(false);
  });
});
