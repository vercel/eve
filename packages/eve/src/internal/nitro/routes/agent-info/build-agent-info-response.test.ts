import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";

describe("buildAgentInfoResponse", () => {
  it("projects only the effective compiled graph", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: "openai/gpt-5",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "app",
      },
      kernelCapabilities: ["agent"],
      sourceComposition: {
        disabled: [
          {
            slot: "tools/weather",
            source: {
              logicalPath: "tools/weather.ts",
              owner: { kind: "application" },
              sourceId: "disabled-weather",
            },
          },
        ],
        shadowed: [],
        sourceOwners: {},
      },
    });

    const response = buildAgentInfoResponse(
      { manifest },
      { gatewayCredentials: { apiKey: false, oidc: false }, mode: "development" },
    );

    expect(response.tools.static).toEqual([]);
    expect(response.kernel.prepared.map((capability) => capability.name)).toEqual(["agent"]);
    expect(response.kernel.reserved.map((capability) => capability.name)).toEqual(["final_output"]);
    expect(response.composition.disabled).toHaveLength(1);
    expect(AgentInfoResultSchema.safeParse(response).success).toBe(true);
  });

  it("reports unresolved dynamic models without importing their modules", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        dynamicModel: {
          eventNames: ["turn.started"],
          logicalPath: "agent.ts",
          sourceId: "agent-config",
          sourceKind: "module",
        },
        name: "app",
      },
    });

    const response = buildAgentInfoResponse(
      { manifest },
      { gatewayCredentials: { apiKey: false, oidc: false }, mode: "development" },
    );

    expect(response.agent.model).toEqual({
      reasoning: undefined,
      routing: { kind: "dynamic" },
    });
    expect("id" in response.agent.model).toBe(false);
  });
});
