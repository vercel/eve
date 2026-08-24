import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createCompileMetadata,
  publishCompilerArtifactFiles,
} from "../../src/compiler/artifacts.js";
import { compileAgent } from "../../src/compiler/compile-agent.js";
import {
  createCompiledModuleMapDescriptorModuleSource,
  createCompiledModuleMapIdentity,
} from "../../src/compiler/module-map.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "../../src/internal/application/runtime-compiled-artifacts-source.js";
import { serializeArtifactJson } from "../../src/protocol/artifact-json.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { loadCompiledArtifactSet } from "../../src/runtime/loaders/compiled-artifact-set.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";
import { summarizeCompilerDiagnostics } from "../../src/shared/compiler-diagnostics.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const compatibilityManifest = JSON.stringify({
  kind: "eve-extension",
  formatVersion: 2,
  builtWithEve: "0.0.0-test",
  build: { externalDependencies: [] },
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

    const compileResult = await compileAgent({ startPath: app.appRoot });

    const compiledArtifactsSource = createAuthoredSourceRuntimeCompiledArtifactsSource(app.appRoot);
    const compiledManifest = await loadCompiledManifest({ compiledArtifactsSource });
    const extensionTool = compiledManifest.tools.find((tool) => tool.name === "crm__crm_echo");
    if (extensionTool === undefined) {
      throw new Error("Expected the compiled extension tool.");
    }
    const extensionBinding = compiledManifest.bindings[extensionTool.sourceId];
    if (extensionBinding === undefined) {
      throw new Error("Expected the compiled extension binding.");
    }
    const opaqueSourceId = "opaque-extension-tool-source";
    const bindings = { ...compiledManifest.bindings };
    delete bindings[extensionTool.sourceId];
    bindings[opaqueSourceId] = extensionBinding;
    const opaqueManifest = {
      ...compiledManifest,
      bindings,
      sourceComposition: {
        ...compiledManifest.sourceComposition,
        selected: compiledManifest.sourceComposition.selected.map((source) =>
          source.sourceKind === "module" && source.sourceId === extensionTool.sourceId
            ? { ...source, sourceId: opaqueSourceId }
            : source,
        ),
      },
      tools: compiledManifest.tools.map((tool) =>
        tool.sourceId === extensionTool.sourceId ? { ...tool, sourceId: opaqueSourceId } : tool,
      ),
    };
    const compiledManifestJson = serializeArtifactJson(opaqueManifest);
    const [diagnosticsArtifactJson, discoveryManifestJson] = await Promise.all([
      readFile(compileResult.paths.diagnosticsPath, "utf8"),
      readFile(compileResult.paths.discoveryManifestPath, "utf8"),
    ]);
    const moduleMapIdentity = await createCompiledModuleMapIdentity(opaqueManifest);
    const moduleMapSource = createCompiledModuleMapDescriptorModuleSource({
      identity: moduleMapIdentity,
      manifest: opaqueManifest,
      moduleMapPath: compileResult.paths.moduleMapPath,
    });
    const metadata = createCompileMetadata({
      appRoot: app.appRoot,
      compiledManifestJson,
      diagnosticsArtifactJson,
      diagnosticsSummary: summarizeCompilerDiagnostics(compileResult.diagnostics),
      discoveryManifestJson,
      moduleMapIdentity,
      moduleMapSource,
      paths: compileResult.paths,
    });
    await publishCompilerArtifactFiles({
      metadataJson: serializeArtifactJson(metadata),
      paths: compileResult.paths,
      payloads: {
        compiledManifestJson,
        diagnosticsArtifactJson,
        discoveryManifestJson,
        moduleMapSource,
      },
    });

    const { manifest, moduleMap } = await loadCompiledArtifactSet({ compiledArtifactsSource });
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });

    const tool = graph.root.agent.tools.find((entry) => entry.name === "crm__crm_echo");
    expect(tool).toBeDefined();
    await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual({
      apiKey: "sk-authored",
    });
  });
});
