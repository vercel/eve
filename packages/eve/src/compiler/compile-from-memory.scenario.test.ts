import { describe, expect, it } from "vitest";

import { compileAgent } from "#compiler/compile-agent.js";
import { compileFromMemory } from "#compiler/compile-from-memory.js";
import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledAgentManifest } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { type ScenarioAppDescriptor, useScenarioApp } from "#internal/testing/scenario-app.js";
import { createDiskRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledArtifactSet } from "#runtime/loaders/compiled-artifact-set.js";

const materializeApp = useScenarioApp();

const FILESYSTEM_EQUIVALENCE_APP: ScenarioAppDescriptor = {
  files: {
    "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };\n',
    "agent/instructions.ts": 'export default { content: "You are a test agent." };\n',
    "agent/skills/greeting.ts":
      'export default { description: "Greet", markdown: "# Greeting\\n" };\n',
    "agent/tools/echo.ts": [
      'export default { description: "Echo", inputSchema: { type: "object" },',
      "  execute(input: unknown) { return input; } };",
      "",
    ].join("\n"),
  },
  name: "memory-source-equivalence",
};

describe("compileFromMemory source-graph parity", () => {
  it("matches filesystem ownership, config provenance, kernel planning, and module keys", async () => {
    const app = await materializeApp(FILESYSTEM_EQUIVALENCE_APP);
    const filesystemCompilation = await compileAgent({ startPath: app.appRoot });
    const filesystemArtifacts = await loadCompiledArtifactSet({
      compiledArtifactsSource: createDiskRuntimeCompiledArtifactsSource(app.appRoot),
    });
    const memoryCompilation = await compileFromMemory({
      model: "openai/gpt-5.4",
      name: FILESYSTEM_EQUIVALENCE_APP.name,
      tools: [{ description: "Echo", inputSchema: { type: "object" }, name: "echo" }],
      skills: [{ description: "Greet", markdown: "# Greeting\n", name: "greeting" }],
    });

    expect(projectBindingOwners(memoryCompilation.manifest)).toEqual(
      projectBindingOwners(filesystemCompilation.manifest),
    );
    expect(projectConfigProvenance(memoryCompilation.manifest)).toEqual(
      projectConfigProvenance(filesystemCompilation.manifest),
    );
    expect(memoryCompilation.manifest.kernelPlan).toEqual(
      filesystemCompilation.manifest.kernelPlan,
    );
    expect(memoryCompilation.manifest.workspaceResourceRoot).toEqual(
      filesystemCompilation.manifest.workspaceResourceRoot,
    );
    expect(
      projectModuleLogicalPaths(memoryCompilation.manifest, memoryCompilation.moduleMap),
    ).toEqual(
      projectModuleLogicalPaths(filesystemCompilation.manifest, filesystemArtifacts.moduleMap),
    );
  });
});

function projectBindingOwners(manifest: CompiledAgentManifest) {
  return Object.values(manifest.bindings)
    .map((binding) => ({ logicalPath: binding.logicalPath, owner: binding.owner }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function projectConfigProvenance(manifest: CompiledAgentManifest) {
  const source = manifest.config.source;
  const binding = manifest.bindings[source.sourceId];
  if (binding === undefined) throw new Error("Compiled config source is missing its binding.");
  return { logicalPath: source.logicalPath, owner: binding.owner };
}

function projectModuleLogicalPaths(
  manifest: CompiledAgentManifest,
  moduleMap: CompiledModuleMap,
): string[] {
  return Object.keys(moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]?.modules ?? {})
    .map((sourceId) => {
      const binding = manifest.bindings[sourceId];
      if (binding === undefined) throw new Error(`Module "${sourceId}" is missing its binding.`);
      return binding.logicalPath;
    })
    .sort();
}
