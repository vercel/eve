import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

/**
 * The directory mount form with a co-located override slot. The extension's own
 * tools compose and bind config, while a consumer override of the same name
 * shadows the extension's contribution. Runs through the dev/eval authored-source
 * loader to exercise directory discovery and override precedence deterministically.
 */
describe("mounted extension via directory form with override", () => {
  it("binds base config and lets a co-located override shadow or disable a tool", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-directory-override",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/crm/extension.mjs": [
          'import crm from "@acme/crm";',
          'export default crm({ apiKey: "sk-dir" });',
          "",
        ].join("\n"),
        // Co-located override: shadows the extension's own crm_status.
        "agent/extensions/crm/tools/crm_status.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Report the consumer status.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { status: "consumer-status" };',
          "  },",
          "});",
          "",
        ].join("\n"),
        // Co-located override: opts out of the extension's own crm_legacy.
        "agent/extensions/crm/tools/crm_legacy.mjs": [
          'import { disableTool } from "eve/tools";',
          "export default disableTool();",
          "",
        ].join("\n"),
        // Co-located override: opts out of the extension's dynamic crm_pulse.
        "agent/extensions/crm/tools/crm_pulse.mjs": [
          'import { disableTool } from "eve/tools";',
          "export default disableTool();",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/package.json": `${JSON.stringify({
          name: "@acme/crm",
          type: "module",
          eve: { extension: "ext" },
          exports: { ".": "./ext/extension.mjs" },
        })}\n`,
        "node_modules/@acme/crm/ext/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "const config = { '~standard': { version: 1, vendor: 'scenario', validate: (value) => ({ value }) } };",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/ext/tools/crm_echo.mjs": [
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
        "node_modules/@acme/crm/ext/tools/crm_status.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Report the extension status.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { status: "extension-status" };',
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/ext/tools/crm_legacy.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "A legacy tool the consumer opts out of.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          "    return { legacy: true };",
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/crm/ext/tools/crm_pulse.mjs": [
          'import { defineDynamic, defineTool } from "eve/tools";',
          "export default defineDynamic({",
          "  events: {",
          '    "session.started": async () =>',
          "      defineTool({",
          '        description: "A dynamic tool the consumer opts out of.",',
          "        inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "        async execute() {",
          "          return { pulse: true };",
          "        },",
          "      }),",
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

    const echo = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(echo).toBeDefined();
    await expect(echo?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-dir",
    });

    const status = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_status");
    expect(status).toBeDefined();
    await expect(status?.execute?.({}, { messages: [], toolCallId: "call_2" })).resolves.toEqual({
      status: "consumer-status",
    });

    const legacy = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_legacy");
    expect(legacy).toBeUndefined();

    const pulse = graph.root.agent.dynamicToolResolvers.find(
      (resolver) => resolver.slug === "crm__crm_pulse",
    );
    expect(pulse).toBeUndefined();
  });
});
