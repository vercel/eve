import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();

/**
 * A no-config extension declares `defineExtension()` with no schema and is
 * mounted with a bare re-export (`export { default } from "pkg"`) — no factory
 * call. Its tools still compose under the mount namespace and run. Proves config
 * is optional end to end through the dev/eval loader.
 */
describe("mounted extension without config", () => {
  it("composes and runs a no-config extension mounted via re-export", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-no-config",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "You are a precise assistant.\n",
        "agent/extensions/widget.mjs": 'export { default } from "@acme/widget";\n',
        "node_modules/@acme/widget/package.json": `${JSON.stringify({
          name: "@acme/widget",
          type: "module",
          eve: { extension: "ext" },
          exports: { ".": "./ext/extension.mjs" },
        })}\n`,
        // No config: `defineExtension()` with no schema. Nothing to bind; the
        // consumer mounts it with a bare re-export.
        "node_modules/@acme/widget/ext/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "export default defineExtension();",
          "",
        ].join("\n"),
        "node_modules/@acme/widget/ext/tools/widget_ping.mjs": [
          'import { defineTool } from "eve/tools";',
          "export default defineTool({",
          '  description: "Return a fixed widget token.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { token: "widget-ok" };',
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

    const tool = graph.root.agent.tools.find((entry) => entry.name === "widget__widget_ping");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      token: "widget-ok",
    });
  });
});
