import { describe, expect, it } from "vitest";

import {
  defaultDevelopmentExtensions,
  prepareDevelopmentExtensions,
} from "#compiler/development-extensions.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { validateCompiledModuleMap } from "#compiler/validate-artifact.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";

function manifest() {
  return createAgentSourceManifest({
    agentId: "source-test",
    agentRoot: "/virtual/source-test/agent",
    appRoot: "/virtual/source-test",
  });
}

describe("development extensions", () => {
  it("mounts the built-in self-modification extension at the root", async () => {
    const compiled = await compileAgentManifest(manifest(), {
      developmentExtensions: defaultDevelopmentExtensions(),
    });
    expect(compiled.subagents).toHaveLength(1);
    const subagent = compiled.subagents[0]!;
    expect(subagent.name).toBe("self-modification__agent");

    expect(compiled.extensionMounts).toMatchObject([
      {
        mountLogicalPath: "extensions/self-modification.ts",
        namespace: "self-modification",
        packageName: "eve",
      },
    ]);
    expect(subagent.agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["edit_file", "search_models", "search_registry"]),
    );
    expect(subagent.agent.dynamicTools.map((tool) => tool.slug)).toEqual(
      expect.arrayContaining(["publish", "registry_add"]),
    );
    expect(subagent.agent.dynamicInstructions).toHaveLength(1);

    const moduleMap = await createProgrammaticCompiledModuleMap(compiled, [
      frameworkAgentSourceRegistry,
    ]);
    expect(() => validateCompiledModuleMap(compiled, moduleMap)).not.toThrow();
  });

  it("does not replace an authored self-modification mount", async () => {
    const authored = manifest();
    authored.extensions.push({
      logicalPath: "extensions/self-modification.ts",
      sourceId: "extensions/self-modification.ts",
      sourceKind: "module",
    });

    const prepared = await prepareDevelopmentExtensions({
      diagnostics: [],
      manifest: authored,
      nodeId: "root",
      selection: defaultDevelopmentExtensions(),
    });

    expect(prepared.manifest.resolvedExtensions).toEqual([]);
    expect(prepared.candidates).toEqual([]);
  });
});
