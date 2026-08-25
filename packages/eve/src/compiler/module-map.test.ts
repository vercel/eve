import { describe, expect, it, vi } from "vitest";

import { compileFromMemory } from "#compiler/compile-from-memory.js";
import {
  collectModuleBindingsForManifest,
  createCompiledModuleMapSource,
  createProgrammaticCompiledModuleMap,
} from "#compiler/module-map.js";

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
  it("renders every selected binding and no shadowed source", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }],
    });
    const source = createCompiledModuleMapSource({
      manifest,
      moduleMapPath: "/app/.eve/compile/module-map.mjs",
    });

    for (const sourceId of Object.keys(manifest.bindings)) {
      expect(source).toContain(JSON.stringify(sourceId));
    }
    for (const entry of manifest.sourceComposition.entries) {
      if (entry.kind === "shadowed") {
        expect(source).not.toContain(JSON.stringify(entry.source.sourceId));
      }
    }
    expect(source).toContain("loadFrameworkProgrammaticModule");
  });

  it("collects exactly the node binding table plus explicit remote bindings", async () => {
    const { manifest } = await compileFromMemory({
      model: "openai/gpt-5.4",
      tools: [{ name: "weather" }, { name: "echo" }],
    });

    expect(collectModuleBindingsForManifest(manifest).map((entry) => entry.sourceId)).toEqual(
      Object.keys(manifest.bindings).sort(),
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
});
