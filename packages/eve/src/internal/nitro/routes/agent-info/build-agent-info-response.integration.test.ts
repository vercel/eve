import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { buildAgentInfoResponse } from "#internal/nitro/routes/agent-info/build-agent-info-response.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

const tool = (description: string) =>
  [
    'import { defineTool } from "eve/tools";',
    `export default defineTool({ description: ${JSON.stringify(description)}, inputSchema: { type: "object" }, async execute() { return "ok"; } });`,
    "",
  ].join("\n");

describe("buildAgentInfoResponse from a real agent root", () => {
  const createAppRoot = useTemporaryAppRoots();

  it("never serializes the server's filesystem root in production", async () => {
    const app = await createAppRoot("eve-agent-info-paths-", {
      files: {
        "agent/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
        "agent/instructions.md": "Answer briefly.\n",
        "agent/tools/weather.ts": tool("Gets weather."),
        "agent/subagents/helper/agent.ts":
          'import { defineAgent } from "eve";\nexport default defineAgent({ description: "Help.", model: "openai/gpt-5.4" });\n',
        "agent/subagents/helper/tools/lookup.ts": tool("Looks things up."),
      },
    });
    const discovered = await discoverAgent({ agentRoot: app.agentRoot, appRoot: app.appRoot });
    const manifest = await compileAgentManifest(discovered.manifest);

    const response = buildAgentInfoResponse(
      { manifest, schedules: [] },
      { gatewayCredentials: { apiKey: false, oidc: false }, mode: "production" },
    );

    // The canary must actually have compiled authored files from this root.
    expect(response.tools.static.map((entry) => entry.name)).toContain("weather");
    expect(response.subagents.local.map((entry) => entry.name)).toContain("helper");
    const serialized = JSON.stringify(response);
    for (const root of new Set([app.appRoot, await realpath(app.appRoot)])) {
      expect(serialized).not.toContain(root);
    }
    expect(() => AgentInfoResultSchema.parse(response)).not.toThrow();
  });
});
