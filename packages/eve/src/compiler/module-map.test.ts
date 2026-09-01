import { describe, expect, it, vi } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  collectRuntimeModuleBindingsForManifest,
  createCompiledModuleMapSource,
  createProgrammaticCompiledModuleMap,
} from "#compiler/module-map.js";
import { validateCompiledAgentManifest } from "#compiler/validate-artifact.js";

const mocks = vi.hoisted(() => ({
  loadAuthoredModuleNamespace: vi.fn(
    async (
      _sourcePath: string,
      _options: {
        readonly externalDependencies: readonly string[];
        readonly extensionScopeNamespace?: string;
      },
    ) => ({}),
  ),
}));

vi.mock("#internal/authored-module-loader.js", () => ({
  loadAuthoredModuleNamespace: mocks.loadAuthoredModuleNamespace,
}));

describe("compiled module maps", () => {
  it("renders every runtime binding and no compile-only or shadowed source", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });
    const source = createCompiledModuleMapSource({
      manifest,
      moduleMapPath: "/app/.eve/compile/module-map.mjs",
    });

    for (const [sourceId, binding] of Object.entries(manifest.bindings)) {
      if (binding.usage.runtimeEntry) expect(source).toContain(JSON.stringify(sourceId));
      else expect(source).not.toContain(JSON.stringify(sourceId));
    }
    for (const entry of manifest.sourceComposition.entries) {
      if (entry.kind === "shadowed") {
        expect(source).not.toContain(JSON.stringify(entry.source.sourceId));
      }
    }
    expect(source).toContain("loadFrameworkProgrammaticModule");
    expect(source).toContain("memoizeModuleNamespaceFactories");
  });

  it("collects exactly the runtime node bindings plus explicit remote bindings", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }, { name: "echo" }],
    });

    expect(
      collectRuntimeModuleBindingsForManifest(manifest).map((entry) => entry.sourceId),
    ).toEqual(
      Object.entries(manifest.bindings)
        .filter(([, binding]) => binding.usage.runtimeEntry)
        .map(([sourceId]) => sourceId)
        .sort(),
    );
  });

  it("uses the selected semantic revision in generated programmatic loads", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const sandboxBinding = manifest.bindings[manifest.sandbox.sourceId]!;
    const source = createCompiledModuleMapSource({
      manifest,
      moduleMapPath: "/app/.eve/compile/module-map.mjs",
    });

    expect(sandboxBinding.backing).toMatchObject({
      kind: "programmatic",
      semanticRevision: "eve:default-sandbox:v1",
    });
    expect(source).toContain("eve:default-sandbox:v1");
  });

  it("loads extension bindings with their stable package namespace", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const [extensionSourceId, ...applicationSourceIds] = Object.keys(manifest.bindings).sort();
    if (extensionSourceId === undefined) throw new Error("Expected at least one module binding.");
    manifest.bindings[extensionSourceId] = {
      backing: {
        externalDependencies: [],
        extensionScope: { namespace: "renamed-mount", sourceRoot: "/extension" },
        kind: "filesystem",
        sourcePath: "/extension/tool.ts",
      },
      logicalPath: "tools/renamed-mount__tool.ts",
      owner: { kind: "extension", namespace: "renamed-mount", packageName: "@acme/crm" },
      usage: { compile: true, runtimeEntry: true },
    };
    for (const sourceId of applicationSourceIds) {
      manifest.bindings[sourceId] = {
        backing: {
          externalDependencies: [],
          kind: "filesystem",
          sourcePath: `/application/${sourceId}.ts`,
        },
        logicalPath: manifest.bindings[sourceId]!.logicalPath,
        owner: { kind: "application" },
        usage: manifest.bindings[sourceId]!.usage,
      };
    }
    mocks.loadAuthoredModuleNamespace.mockClear();

    await createProgrammaticCompiledModuleMap(manifest, []);

    expect(mocks.loadAuthoredModuleNamespace).toHaveBeenCalledWith("/extension/tool.ts", {
      externalDependencies: [],
      extensionScopeNamespace: "acme-crm",
    });
    expect(
      mocks.loadAuthoredModuleNamespace.mock.calls
        .filter(([sourcePath]) => sourcePath.startsWith("/application/"))
        .every(([, options]) => options.extensionScopeNamespace === undefined),
    ).toBe(true);
  });

  it("orders and renders programmatic dependencies in generated maps", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });
    const tool = manifest.tools.find((candidate) => candidate.name === "weather")!;
    const configSourceId = manifest.config.source.sourceId;
    const binding = manifest.bindings[tool.sourceId]!;
    if (binding.backing.kind !== "programmatic") {
      throw new Error("Expected a programmatic tool binding.");
    }
    manifest.bindings[tool.sourceId] = {
      ...binding,
      backing: {
        ...binding.backing,
        dependencies: { config: configSourceId },
        parameters: { role: "derived" },
      },
    };
    manifest.bindings[configSourceId] = {
      ...manifest.bindings[configSourceId]!,
      usage: { ...manifest.bindings[configSourceId]!.usage, runtimeEntry: true },
    };

    const ordered = collectRuntimeModuleBindingsForManifest(manifest).map(
      (entry) => entry.sourceId,
    );
    const source = createCompiledModuleMapSource({
      manifest,
      moduleMapPath: "/app/.eve/compile/module-map.mjs",
    });

    expect(ordered.indexOf(configSourceId)).toBeLessThan(ordered.indexOf(tool.sourceId));
    expect(source).toContain('"parameters":{"role":"derived"}');
    expect(source).toMatch(/Object\.freeze\(\{ "config": module_\d+ \}\)/);
  });

  it("rejects missing and cyclic programmatic binding dependencies", async () => {
    const { manifest } = await compileFromMemory({ model: "openai/gpt-5.4" });
    const sourceId = manifest.config.source.sourceId;
    const binding = manifest.bindings[sourceId]!;
    if (binding.backing.kind !== "programmatic") {
      throw new Error("Expected a programmatic config binding.");
    }

    manifest.bindings[sourceId] = {
      ...binding,
      backing: { ...binding.backing, dependencies: { missing: "missing-source" } },
    };
    expect(() => validateCompiledAgentManifest(manifest)).toThrow(
      `programmatic binding "${sourceId}" depends on missing binding "missing-source"`,
    );

    manifest.bindings[sourceId] = {
      ...binding,
      backing: { ...binding.backing, dependencies: { self: sourceId } },
    };
    expect(() => validateCompiledAgentManifest(manifest)).toThrow(
      `programmatic binding dependency cycle includes "${sourceId}"`,
    );
  });
});
