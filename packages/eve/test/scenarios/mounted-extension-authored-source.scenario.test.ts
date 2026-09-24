import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { ContextContainer, contextStorage } from "../../src/context/container.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { BundleKey, type CompiledBundle } from "../../src/runtime/sessions/runtime-context-keys.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const compatibilityManifest = JSON.stringify({
  kind: "eve-extension",
  formatVersion: 1,
  builtWithEve: "0.0.0-test",
  requires: { extension: 1, tool: 1, config: 1 },
});

/**
 * Runs the `eve eval` / `eve dev` path: the module map is hydrated from authored
 * source, so the extension-scope plugin must bind config across separately-bundled
 * mount and tool modules. Deterministic guard for the config-binding regression.
 */
describe("mounted extension via authored-source loader", () => {
  it("binds mounted config so a composed tool reads it", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-authored-source",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-authored" });',
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: { source: "source", dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest,
        "node_modules/@acme/crm/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          // Minimal pass-through Standard Schema — this scenario tests binding, not validation.
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/extension/tools/crm_echo.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Echo the configured API key.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { apiKey: extension.config.apiKey };",
          "  },",
          "});",
          "",
        ].join("\n"),
      },
    });

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const tool = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-authored",
    });
  });

  it("keeps each agent's config when one extension is mounted in several agents", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-authored-source-multi-mount",
      installDependencies: true,
      files: {
        ...crmExtensionPackageFiles(),
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-root" });',
          "",
        ].join("\n"),
        "agent/subagents/researcher/agent.mjs": [
          "export default {",
          '  model: "openai/gpt-5.4",',
          '  description: "Research a focused account set.",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/researcher/instructions.md": "You research accounts.\n",
        "agent/subagents/researcher/extensions/crm.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-researcher" });',
          "",
        ].join("\n"),
      },
    });

    await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createDiskRuntimeCompiledArtifactsSource(app.appRoot);
    const [manifest, moduleMap] = await Promise.all([
      loadCompiledManifest({ compiledArtifactsSource }),
      loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource }),
    ]);
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const researcherNodeId = manifest.subagents[0]?.nodeId;
    expect(researcherNodeId).toBeDefined();
    const researcher = graph.nodesByNodeId.get(researcherNodeId ?? "");
    expect(researcher).toBeDefined();

    // Sessions run with the bundle of their agent node in context; the root
    // bundle carries no node id.
    const echoInSession = async (
      nodeId: string | undefined,
      tools: readonly { name: string; execute?: unknown }[] | undefined,
    ) => {
      const execute = tools?.find((entry) => entry.name === "crm__crm_echo")?.execute as
        | ((input: object, options: object) => Promise<unknown>)
        | undefined;
      expect(execute).toBeDefined();
      const ctx = new ContextContainer();
      ctx.set(BundleKey, { nodeId } as CompiledBundle);
      return await contextStorage.run(ctx, () =>
        execute!({}, { messages: [], toolCallId: "call_1" }),
      );
    };

    await expect(echoInSession(undefined, graph.root.agent.tools)).resolves.toEqual({
      apiKey: "sk-root",
    });
    await expect(echoInSession(researcherNodeId, researcher?.agent.tools)).resolves.toEqual({
      apiKey: "sk-researcher",
    });
  });
});

function crmExtensionPackageFiles(): Record<string, string> {
  return {
    "node_modules/@acme/crm/package.json": `${JSON.stringify({
      name: "@acme/crm",
      type: "module",
      eve: { extension: { source: "source", dist: "extension" } },
      exports: { ".": "./extension/extension.mjs" },
    })}\n`,
    "node_modules/@acme/crm/extension/_manifest.json": compatibilityManifest,
    "node_modules/@acme/crm/extension/extension.mjs": [
      'import { defineExtension } from "eve/extension";',
      "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
      "export default defineExtension({ config });",
      "",
    ].join("\n"),
    "node_modules/@acme/crm/extension/tools/crm_echo.mjs": [
      'import { defineTool } from "eve/tools";',
      'import extension from "../extension.mjs";',
      "export default defineTool({",
      '  description: "Echo the configured API key.",',
      "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
      "  async execute() {",
      "    return { apiKey: extension.config.apiKey };",
      "  },",
      "});",
      "",
    ].join("\n"),
  };
}
