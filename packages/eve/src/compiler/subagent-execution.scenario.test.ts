import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
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
    const toolNames = child?.agent.tools.map((tool) => tool.name);
    expect(toolNames).toContain("task_cancel");
    expect(toolNames).not.toContain("task_update");
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

  it("compiles a subagent's choice() models for its caller", async () => {
    // The shape `choice()` from `eve/models` returns.
    const model = JSON.stringify({
      kind: "eve.model-choice",
      choices: [
        { model: "openai/gpt-5.4-mini", description: "Quick drafts." },
        {
          model: "openai/gpt-5.4",
          modelOptions: { providerOptions: { gateway: { models: ["anthropic/claude-opus-4.7"] } } },
        },
      ],
    });
    const app = await scenarioApp({
      files: {
        "agent/agent.ts":
          "export default { model: 'openai/gpt-5.5', modelContextWindowTokens: 200000 };\n",
        "agent/subagents/researcher/agent.ts": `export default { description: 'Research.', model: ${model} };\n`,
      },
      name: "subagent-model-choice",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);
    const child = manifest.subagents[0];
    if (child === undefined || child.configResolver !== undefined) {
      throw new Error("Expected a static child.");
    }
    const config = child.agent.config;

    expect(compiledAgentManifestSchema.parse(manifest)).toEqual(manifest);
    expect(config.model?.id).toBe("openai/gpt-5.4-mini");
    expect(config.modelChoices).toEqual([
      expect.objectContaining({
        description: "Quick drafts.",
        model: expect.objectContaining({ id: "openai/gpt-5.4-mini" }),
      }),
      {
        model: expect.objectContaining({
          contextWindowTokens: expect.any(Number),
          id: "openai/gpt-5.4",
          providerOptions: { gateway: { models: ["anthropic/claude-opus-4.7"] } },
        }),
      },
    ]);
  });
});
