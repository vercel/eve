import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

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
          eve: { extension: "extension" },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
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
});
