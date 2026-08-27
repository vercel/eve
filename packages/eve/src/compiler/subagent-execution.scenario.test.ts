import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("subagent execution compilation", () => {
  const scenarioApp = useScenarioApp();

  it("stores execution on the parent edge and keeps it out of child config", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts":
          "export default { experimental: { tasks: true }, model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
        "agent/subagents/researcher/agent.ts":
          "export default { background: true, description: 'Research.', kind: 'eve:local-subagent', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
      },
      name: "subagent-execution-edge",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    const child = manifest.subagents[0];

    expect(child).toMatchObject({ execution: "background" });
    if (child?.configResolver !== undefined) throw new Error("Expected a static child.");
    expect(child?.agent.config).not.toHaveProperty("background");
    expect(child?.agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["task_cancel", "task_update"]),
    );
  });

  it("rejects a background subagent without the root task gate", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.ts":
          "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
        "agent/subagents/researcher/agent.ts":
          "export default { background: true, description: 'Research.', kind: 'eve:local-subagent', model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
      },
      name: "subagent-execution-gate",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });

    await expect(compileAgentManifest(discovered.manifest)).rejects.toThrow(
      'Background subagent "researcher" requires experimental.tasks: true',
    );
  });
});
