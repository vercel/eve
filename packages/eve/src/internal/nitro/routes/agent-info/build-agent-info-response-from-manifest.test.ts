import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { buildAgentInfoResponseFromManifest } from "#internal/nitro/routes/agent-info/build-agent-info-response-from-manifest.js";

describe("buildAgentInfoResponseFromManifest", () => {
  it("does not invent tools absent from compiled artifacts", () => {
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
    });

    const result = buildAgentInfoResponseFromManifest(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "development",
      },
    );

    expect(result.tools.available.map((tool) => tool.name)).not.toContain("glob");
    expect(result.tools.available.map((tool) => tool.name)).not.toContain("grep");
    expect(result.tools.framework).toEqual([]);
    expect(AgentInfoResultSchema.safeParse(result).success).toBe(true);
  });

  it("reports unresolved dynamic models without a model id", () => {
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

    const result = buildAgentInfoResponseFromManifest(
      { manifest, schedules: [] },
      {
        gatewayCredentials: { apiKey: false, oidc: false },
        mode: "development",
      },
    );

    expect(result.agent.model).toEqual({
      reasoning: undefined,
      routing: { kind: "dynamic" },
    });
    expect("id" in result.agent.model).toBe(false);
    expect(AgentInfoResultSchema.safeParse(result).success).toBe(true);
  });
});
