import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { discoverAgent } from "#discover/discover-agent.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

describe("authored module lifecycle", () => {
  const scenarioApp = useScenarioApp();

  it("classifies static, dynamic, direct-model, and remote subagent configs", async () => {
    const app = await scenarioApp({
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/subagents/direct-model/agent.mjs": [
          "const model = {",
          '  specificationVersion: "v3",',
          '  provider: "test-provider",',
          '  modelId: "direct-model",',
          "  async doGenerate() { return {}; },",
          "  async doStream() { return {}; },",
          "};",
          "export default {",
          '  description: "Uses a direct provider model.",',
          "  model,",
          "  modelContextWindowTokens: 8192,",
          "};",
          "",
        ].join("\n"),
        "agent/subagents/dynamic-model/agent.mjs": [
          "export default {",
          '  description: "Chooses a model at runtime.",',
          "  model: {",
          '    kind: "eve:dynamic",',
          '    events: { "session.started": () => "openai/gpt-5.4" },',
          "  },",
          "};",
          "",
        ].join("\n"),
        "agent/subagents/dynamic/agent.mjs": [
          "export default {",
          '  kind: "eve:dynamic",',
          "  events: {",
          '    "session.started": () => ({',
          '      description: "Dynamically available.",',
          '      model: "openai/gpt-5.4",',
          "    }),",
          "  },",
          "};",
          "",
        ].join("\n"),
        "agent/subagents/remote.mjs": [
          "export default {",
          '  description: "Calls a remote deployment.",',
          '  kind: "remote",',
          '  path: "/eve/v1/session",',
          '  url: "https://remote.example.com",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/static/agent.mjs": [
          "export default {",
          '  description: "Always available.",',
          '  model: "openai/gpt-5.4",',
          "};",
          "",
        ].join("\n"),
      },
      name: "module-lifecycle-subagents",
    });
    const discovered = await discoverAgent({
      agentRoot: join(app.appRoot, "agent"),
      appRoot: app.appRoot,
    });
    const manifest = await compileAgentManifest(discovered.manifest);

    expect(manifest.bindings[manifest.config.source.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: false,
    });

    const staticNode = manifest.subagents.find((node) => node.name === "static")!;
    expect(staticNode.configResolver).toBeUndefined();
    if (!("config" in staticNode.agent)) throw new Error("Expected a static subagent config.");
    expect(staticNode.agent.bindings[staticNode.agent.config.source.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: false,
    });

    const dynamicNode = manifest.subagents.find((node) => node.name === "dynamic")!;
    expect(dynamicNode.configResolver).toBeDefined();
    expect(dynamicNode.agent.bindings[dynamicNode.configResolver!.sourceId]?.usage).toEqual({
      compile: true,
      runtimeEntry: true,
    });

    for (const name of ["dynamic-model", "direct-model"]) {
      const node = manifest.subagents.find((candidate) => candidate.name === name)!;
      if (!("config" in node.agent)) throw new Error(`Expected a static config for ${name}.`);
      expect(node.agent.bindings[node.agent.config.source.sourceId]?.usage).toEqual({
        compile: true,
        runtimeEntry: true,
      });
    }

    const remote = manifest.remoteAgents.find((agent) => agent.name === "remote")!;
    expect(remote.binding.usage).toEqual({ compile: true, runtimeEntry: true });
  });
});
