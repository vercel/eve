import { describe, expect, it } from "vitest";

import {
  resolveSelectedModelProvider,
  resolveSelectedModelProviderStatus,
  type ModelProviderState,
} from "./model-provider-state.js";

const competingState: ModelProviderState = {
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
  });

  it("uses the explicit Gateway preference when credentials compete", () => {
    expect(competingState.available.gatewayProject).toBeDefined();
    expect(competingState.available.gatewayKey).toBeDefined();
    expect(
      resolveSelectedModelProvider(competingState, { kind: "gateway", target: "anthropic" }),
    ).toBe("gateway-project");
    expect(resolveSelectedModelProviderStatus(competingState, "gateway-project")).toEqual({
      kind: "gateway-project",
      projectName: "my-agent",
      teamName: "my-team",
    });
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
    const state: ModelProviderState = {
      available: { gatewayKey: { source: { kind: "shell" } } },
      preferredGatewayCredential: "project",
    };

    expect(resolveSelectedModelProvider(state, { kind: "gateway", target: "anthropic" })).toBe(
      "gateway-project",
    );
    expect(resolveSelectedModelProviderStatus(state, "gateway-project")).toEqual({ kind: "unset" });
  });
});
