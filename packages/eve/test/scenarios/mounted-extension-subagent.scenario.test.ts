import { describe, expect, it } from "vitest";

import { compileAgent } from "../../src/compiler/compile-agent.js";
import { loadCompiledModuleMapFromAuthoredSource } from "../../src/internal/authored-module-map-loader.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { createDiskRuntimeCompiledArtifactsSource } from "../../src/runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "../../src/runtime/loaders/manifest.js";
import { resolveRuntimeAgentGraph } from "../../src/runtime/resolve-agent-graph.js";

const scenarioApp = useScenarioApp();
const compatibilityManifest = JSON.stringify({
  kind: "eve-extension",
  formatVersion: 1,
  builtWithEve: "0.0.0-test",
  requires: { config: 1, extension: 1, instructions: 1, skill: 1, tool: 1 },
});

describe("mounted extensions in local subagents", () => {
  it("mounts one extension in the root and multiple declared subagents", async () => {
    const app = await scenarioApp({
      name: "mounted-extension-subagent",
      installDependencies: true,
      files: {
        "agent/agent.mjs": 'export default { model: "openai/gpt-5.4" };\n',
        "agent/instructions.md": "Route requests to specialists.\n",
        "agent/extensions/shared.mjs": [
          'import shared from "@acme/shared";',
          'export default shared({ marker: "shared-config" });',
          "",
        ].join("\n"),
        "agent/subagents/auditor/agent.mjs": [
          "export default {",
          '  description: "Audit an answer.",',
          '  model: "openai/gpt-5.4",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/auditor/extensions/shared.mjs": [
          'import shared from "@acme/shared";',
          'export default shared({ marker: "shared-config" });',
          "",
        ].join("\n"),
        "agent/subagents/researcher/agent.mjs": [
          "export default {",
          '  description: "Research a question.",',
          '  model: "openai/gpt-5.4",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/researcher/extensions/shared.mjs": [
          'import shared from "@acme/shared";',
          'export default shared({ marker: "shared-config" });',
          "",
        ].join("\n"),
        "agent/subagents/reviewer/agent.mjs": [
          "export default {",
          '  description: "Review an answer.",',
          '  model: "openai/gpt-5.4",',
          "};",
          "",
        ].join("\n"),
        "agent/subagents/reviewer/extensions/shared.mjs": [
          'import review from "@acme/review";',
          'export default review({ marker: "review-config" });',
          "",
        ].join("\n"),
        "node_modules/@acme/shared/package.json": `${JSON.stringify({
          name: "@acme/shared",
          type: "module",
          eve: { extension: { dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/shared/extension/_manifest.json": compatibilityManifest,
        "node_modules/@acme/shared/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "const config = {",
          '  "~standard": {',
          "    version: 1,",
          '    vendor: "scenario",',
          "    validate: (value) => ({ value }),",
          "  },",
          "};",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/shared/extension/instructions.md":
          "Use the shared knowledge workflow.\n",
        "node_modules/@acme/shared/extension/skills/guide/SKILL.md": [
          "---",
          "description: Follow the shared research guide.",
          "---",
          "",
          "# Shared guide",
          "",
        ].join("\n"),
        "node_modules/@acme/shared/extension/tools/search.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Search shared knowledge.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { marker: extension.config.marker, source: "shared-extension" };',
          "  },",
          "});",
          "",
        ].join("\n"),
        "node_modules/@acme/review/package.json": `${JSON.stringify({
          name: "@acme/review",
          type: "module",
          eve: { extension: { dist: "extension" } },
          exports: { ".": "./extension/extension.mjs" },
        })}\n`,
        "node_modules/@acme/review/extension/_manifest.json": compatibilityManifest,
        "node_modules/@acme/review/extension/extension.mjs": [
          'import { defineExtension } from "eve/extension";',
          "const config = {",
          '  "~standard": {',
          "    version: 1,",
          '    vendor: "scenario",',
          "    validate: (value) => ({ value }),",
          "  },",
          "};",
          "export default defineExtension({ config });",
          "",
        ].join("\n"),
        "node_modules/@acme/review/extension/instructions.md":
          "Use the independent review workflow.\n",
        "node_modules/@acme/review/extension/skills/guide/SKILL.md": [
          "---",
          "description: Follow the independent review guide.",
          "---",
          "",
          "# Review guide",
          "",
        ].join("\n"),
        "node_modules/@acme/review/extension/tools/search.mjs": [
          'import { defineTool } from "eve/tools";',
          'import extension from "../extension.mjs";',
          "export default defineTool({",
          '  description: "Review shared knowledge.",',
          "  inputSchema: { type: 'object', properties: {}, additionalProperties: false },",
          "  async execute() {",
          '    return { marker: extension.config.marker, source: "review-extension" };',
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

    expect(manifest.extensionMounts).toHaveLength(1);
    expect(manifest.subagents.map((subagent) => subagent.agent.extensionMounts.length)).toEqual([
      1, 1, 1,
    ]);

    for (const [node, expected] of [
      [graph.root, { marker: "shared-config", source: "shared-extension" }],
      [
        graph.nodesByNodeId.get("subagents/auditor"),
        { marker: "shared-config", source: "shared-extension" },
      ],
      [
        graph.nodesByNodeId.get("subagents/researcher"),
        { marker: "shared-config", source: "shared-extension" },
      ],
      [
        graph.nodesByNodeId.get("subagents/reviewer"),
        { marker: "review-config", source: "review-extension" },
      ],
    ] as const) {
      const tool = node?.agent.tools.find((entry) => entry.name === "shared__search");
      expect(tool).toBeDefined();
      expect(node?.agent.skills.some((skill) => skill.name === "shared__guide")).toBe(true);
      await expect(tool?.execute?.({}, { messages: [], toolCallId: "call_1" })).resolves.toEqual(
        expected,
      );
    }
    expect(graph.root.agent.instructions?.markdown).toContain("Use the shared knowledge workflow.");
    expect(graph.nodesByNodeId.get("subagents/reviewer")?.agent.instructions?.markdown).toContain(
      "Use the independent review workflow.",
    );
  });
});
