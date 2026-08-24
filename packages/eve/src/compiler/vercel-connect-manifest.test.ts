import { describe, expect, it } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import { createVercelConnectManifest } from "#compiler/vercel-connect-manifest.js";

const config = {
  model: { id: "openai/gpt-5.5", routing: classifyModelRouting("openai/gpt-5.5") },
  name: "app",
};

describe("createVercelConnectManifest", () => {
  it("emits a connection requirement without runtime credentials", () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/agent",
      appRoot: "/app",
      config,
      connections: [
        {
          connectionName: "linear",
          description: "Linear",
          logicalPath: "connections/linear.ts",
          protocol: "mcp",
          sourceId: "linear",
          sourceKind: "module",
          url: "https://mcp.linear.app/mcp",
          vercelConnectRequirement: {
            reference: "linear",
            connector: { type: "oauth", configuration: { service: "mcp.linear.app" } },
            access: { principalTypes: ["user"] },
          },
        },
      ],
    });

    expect(createVercelConnectManifest({ manifest, version: "0.42.0" })).toEqual({
      kind: "vercel-connect-manifest",
      schemaVersion: 1,
      generator: { name: "eve", version: "0.42.0" },
      requirements: [
        {
          reference: "linear",
          connector: { type: "oauth", configuration: { service: "mcp.linear.app" } },
          access: { principalTypes: ["user"] },
          resource: { protocol: "mcp", url: "https://mcp.linear.app/mcp" },
          uses: [{ kind: "connection", logicalPath: "connections/linear.ts", name: "linear" }],
        },
      ],
    });
  });

  it("does not emit an artifact for agents without Connect requirements", () => {
    expect(
      createVercelConnectManifest({
        manifest: createCompiledAgentManifest({ agentRoot: "/agent", appRoot: "/app", config }),
        version: "0.42.0",
      }),
    ).toBeUndefined();
  });
});
