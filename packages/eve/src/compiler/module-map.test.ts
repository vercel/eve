import { describe, expect, it, vi } from "vitest";

import { compileFromMemory } from "#internal/testing/compile-from-memory.js";
import {
  createCompiledModuleMapSource,
  createProgrammaticCompiledModuleMap,
} from "#compiler/module-map.js";
import { collectRuntimeModuleBindingsForManifest } from "#compiler/module-map-schema.js";

const mocks = vi.hoisted(() => ({
  loadAuthoredModuleNamespace: vi.fn(
    async (
      _sourcePath: string,
      _options: {
        readonly externalDependencies: readonly string[];
        readonly extension?: { readonly mountId: string };
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

  it("loads extension bindings with their logical mount identity", async () => {
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
      owner: {
        kind: "extension",
        mountId: "extensions/renamed-mount",
        namespace: "renamed-mount",
        packageName: "@acme/crm",
      },
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
      extension: { mountId: "extensions/renamed-mount" },
    });
    expect(
      mocks.loadAuthoredModuleNamespace.mock.calls
        .filter(([sourcePath]) => sourcePath.startsWith("/application/"))
        .every(([, options]) => options.extension === undefined),
    ).toBe(true);
  });
});
