import { describe, expect, it } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { resolveAgent } from "#runtime/resolve-agent.js";

describe("buildAgentInfoResponse", () => {
  it("preserves direct-provider routing from the compiled manifest", async () => {
    const manifest = createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        compaction: {},
        model: {
          id: "openai/gpt-5",
          routing: { kind: "external", provider: "openai" },
        },
        name: "direct-model-agent",
      },
    });
    const agent = await resolveAgent({
      manifest,
      moduleMap: { nodes: { __root__: { modules: {} } } },
    });

    const response = buildAgentInfoResponse(
      { agent, manifest, schedules: [] },
      { mode: "development" },
    );

    expect(response.agent.model).toMatchObject({
      id: "openai/gpt-5",
      routing: { kind: "external", provider: "openai" },
    });
  });
});
