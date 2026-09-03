import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("subagent compilation", () => {
  const scenarioApp = useScenarioApp();

  it("compiles a local subagent without an execution selector", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts":
          "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
        "agent/subagents/researcher/agent.ts":
          "export default { description: 'Research.', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
      },
      name: "subagent-execution-edge",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    const child = manifest.subagents[0];

    expect(child).not.toHaveProperty("execution");
    if (child?.configResolver !== undefined) throw new Error("Expected a static child.");
    expect(child?.agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["task_cancel", "task_update"]),
    );
  });

  it("compiles a subagent without root configuration", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts":
          "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
        "agent/subagents/researcher/agent.ts":
          "export default { description: 'Research.', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
      },
      name: "subagent-execution-gate",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    await expect(compileAgentManifest(discovered.manifest)).resolves.toMatchObject({
      subagents: [expect.objectContaining({ name: "researcher" })],
    });
  });
});
