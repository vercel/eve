import { describe, expect, it } from "vitest";

import { composeAgentConfigSources } from "#compiler/effective-agent-source-graph.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework-sources/registry.js";

describe("default local subagent config", () => {
  it("selects and binds the canonical framework config when agent.ts is omitted", () => {
    const graph = composeAgentConfigSources({
      externalDependencies: [],
      isRoot: false,
      manifest: createAgentSourceManifest({
        agentId: "researcher",
        agentRoot: "/app/agent/subagents/researcher",
        appRoot: "/app",
      }),
      nodeId: "subagents/researcher",
      registry: frameworkAgentSourceRegistry,
    });

    expect(graph.winners).toEqual([
      expect.objectContaining({
        kind: "config",
        source: {
          exportName: undefined,
          logicalPath: "agent.ts",
          sourceId: "eve.framework-defaults:agent.ts",
          sourceKind: "module",
        },
      }),
    ]);
    expect(graph.bindings["eve.framework-defaults:agent.ts"]).toMatchObject({
      backing: {
        kind: "programmatic",
        moduleId: "agent.ts",
        registryId: "eve.framework-defaults",
      },
      logicalPath: "agent.ts",
      owner: { feature: "eve.framework-defaults", kind: "framework" },
    });
  });
});
