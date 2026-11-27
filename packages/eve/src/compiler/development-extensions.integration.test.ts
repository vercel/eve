import { describe, expect, it } from "vitest";
import { compiledOf } from "#compiler/manifest.js";

import {
  defaultDevelopmentExtensions,
  getDevelopmentExtensionSourceRegistry,
  prepareDevelopmentExtensions,
} from "#compiler/development-extensions.js";
import {
  createCompiledModuleMapSource,
  createProgrammaticCompiledModuleMap,
} from "#compiler/module-map.js";
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
    expect(frameworkAgentSourceRegistry.sources.has("eve:development-extension:self")).toBe(false);

    const compiled = await compileAgentManifest(manifest(), {
      developmentExtensions: defaultDevelopmentExtensions(),
    });
    expect(compiled.subagents).toHaveLength(1);
    const subagent = compiled.subagents[0]!;
    expect(subagent.name).toBe("self__modify");

    expect(compiled.extensionMounts).toMatchObject([
      {
        mountLogicalPath: "extensions/self.ts",
        mountId: "extensions/self",
        namespace: "self",
        packageName: "eve",
      },
    ]);
    expect(subagent.owner).toMatchObject({ mountId: "extensions/self" });
    expect(subagent.agent.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["edit_file", "search_models", "search_registry"]),
    );
    expect(compiledOf(subagent.agent, "tool").map((tool) => tool.slug)).toContain("registry_add");
    expect(compiledOf(subagent.agent, "tool").map((tool) => tool.slug)).not.toContain("publish");
    expect(compiledOf(subagent.agent, "instructions")).toHaveLength(1);

    const moduleMap = await createProgrammaticCompiledModuleMap(compiled, [
      frameworkAgentSourceRegistry,
      getDevelopmentExtensionSourceRegistry(),
    ]);
    expect(() => validateCompiledModuleMap(compiled, moduleMap)).not.toThrow();
    const generated = createCompiledModuleMapSource({
      manifest: compiled,
      moduleMapPath: "/virtual/source-test/.eve/compile/module-map.mjs",
    });
    expect(generated).toContain(
      "eve/extensions/self-modification/local?eve-mount=extensions%2Fself",
    );
  });

  it("does not replace an authored self-modification mount", async () => {
    const authored = manifest();
    authored.extensions.push({
      logicalPath: "extensions/self.ts",
      sourceId: "extensions/self.ts",
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

  it("does not duplicate an authored self-modification mount under another namespace", async () => {
    const authored = manifest();
    authored.resolvedExtensions.push({
      externalDependencies: [],
      manifest: createAgentSourceManifest({
        agentId: "self-modification",
        agentRoot: "/virtual/self-modification",
        appRoot: "/virtual",
      }),
      namespace: "self-modification",
      packageName: "eve",
      packageRoot: "/virtual/node_modules/eve",
      sourceRoot: "/virtual/node_modules/eve/dist/src/self-modification/extension",
      specifier: "eve/extensions/self-modification/local",
    });

    const prepared = await prepareDevelopmentExtensions({
      diagnostics: [],
      manifest: authored,
      nodeId: "root",
      selection: defaultDevelopmentExtensions(),
    });

    expect(prepared.manifest.resolvedExtensions).toHaveLength(1);
    expect(prepared.candidates).toEqual([]);
  });
});
