import { describe, expect, it } from "vitest";

import { createCompiledAgentNodeManifest } from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";

import { renderSubagent } from "./build-agent-info-response.js";

describe("renderSubagent", () => {
  it("reports inherited and owned subagent capabilities", () => {
    const subagent = renderSubagent({
      agent: createCompiledAgentNodeManifest({
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
        config: {
          description: "Research one task.",
          inherit: {
            connections: true,
            sandbox: true,
          },
          model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
          name: "researcher",
        },
        connections: [
          {
            connectionName: "linear",
            description: "Use Linear.",
            logicalPath: "connections/linear.ts",
            protocol: "mcp",
            sourceId: "connections/linear.ts",
            sourceKind: "module",
            url: "https://mcp.linear.example",
          },
        ],
      }),
      description: "Research one task.",
      entryPath: "subagents/researcher/agent.ts",
      logicalPath: "subagents/researcher",
      name: "researcher",
      nodeId: "subagents/researcher",
      rootPath: "/app/agent/subagents/researcher",
      sourceId: "subagents/researcher",
      sourceKind: "module",
    });

    expect(subagent.inherit).toEqual({
      connections: true,
      sandbox: true,
    });
    expect(subagent.effective).toEqual({
      connections: {
        inherited: true,
        owned: 1,
      },
      sandbox: "inherited",
    });
  });
});
