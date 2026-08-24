import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { relocateCompiledAgentManifest } from "#internal/nitro/compiled-manifest-relocation.js";
import {
  createGenerationModuleMapBackingProjection,
  createGenerationModuleMapBundleEntry,
  hydrateGenerationModuleMapBackingProjection,
} from "#internal/generation-module-map-projection.js";
import { createStubCompiledAgentManifest } from "#internal/testing/compiled-manifest.js";

const SOURCE_APP_ROOT = "/workspace/apps/agent";
const SOURCE_EXTENSION_ROOT = "/workspace/packages/extension";
const SOURCE_ID = "agent.ts";

function createSourceManifest(): CompiledAgentManifest {
  return createStubCompiledAgentManifest({
    agentRoot: join(SOURCE_APP_ROOT, "agent"),
    appRoot: SOURCE_APP_ROOT,
    bindings: [
      {
        binding: {
          backing: {
            externalDependencies: [],
            kind: "filesystem",
            sourcePath: join(SOURCE_APP_ROOT, "agent", "extensions", "fixture.ts"),
          },
          owner: { kind: "application" },
        },
        logicalPath: "extensions/fixture.ts",
        sourceId: "extensions/fixture.ts",
      },
      {
        binding: {
          backing: {
            externalDependencies: [],
            extensionScope: { namespace: "acme-fixture", sourceRoot: SOURCE_EXTENSION_ROOT },
            kind: "filesystem",
            sourcePath: join(SOURCE_EXTENSION_ROOT, "agent.ts"),
          },
          owner: {
            kind: "extension",
            namespace: "fixture",
            packageName: "@acme/fixture",
          },
        },
        logicalPath: "agent.ts",
        sourceId: SOURCE_ID,
      },
    ],
    config: {
      model: { id: "openai/gpt-5-mini", routing: { kind: "gateway", target: "openai" } },
      name: "projection-test",
      source: { logicalPath: "agent.ts", sourceId: SOURCE_ID, sourceKind: "module" },
    },
    extensionMounts: [
      {
        externalDependencies: [],
        mountLogicalPath: "extensions/fixture.ts",
        mountSourceId: "extensions/fixture.ts",
        namespace: "fixture",
        packageName: "@acme/fixture",
        packageNamespace: "acme-fixture",
        sourceRoot: SOURCE_EXTENSION_ROOT,
      },
    ],
  });
}

function createRelocatedManifest(input: {
  readonly runtimeAppRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceManifest: CompiledAgentManifest;
}): CompiledAgentManifest {
  const relocateWithin = (path: string, sourceRoot: string, targetRoot: string): string => {
    const relativePath = relative(sourceRoot, path);
    return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..")
      ? resolve(targetRoot, relativePath)
      : path;
  };
  return relocateCompiledAgentManifest(input.sourceManifest, {
    appPath: (path) => relocateWithin(path, SOURCE_APP_ROOT, input.runtimeAppRoot),
    physicalPath: (path) => {
      const appPath = relocateWithin(path, SOURCE_APP_ROOT, input.runtimeAppRoot);
      return appPath === path
        ? relocateWithin(path, "/workspace", input.snapshotSourceRoot)
        : appPath;
    },
  });
}

describe("generation module-map projection", () => {
  it("hydrates exact relocated backings without serializing a generation path", () => {
    const runtimeAppRoot =
      "/workspace/apps/agent/.eve/dev-runtime/snapshots/generation-id/source/apps/agent";
    const snapshotSourceRoot =
      "/workspace/apps/agent/.eve/dev-runtime/snapshots/generation-id/source";
    const sourceManifest = createSourceManifest();
    const projectedManifest = createRelocatedManifest({
      runtimeAppRoot,
      snapshotSourceRoot,
      sourceManifest,
    });
    const projection = createGenerationModuleMapBackingProjection({
      projectedManifest,
      runtimeAppRoot,
      sourceManifest,
    });
    const serialized = JSON.stringify(projection);
    const hydrated = hydrateGenerationModuleMapBackingProjection(
      projection,
      runtimeAppRoot,
    ) as Record<string, Record<string, unknown>>;

    expect(serialized).not.toContain("generation-id");
    expect(serialized).toContain("__eveRuntimeRelativePath");
    expect(hydrated.__root__?.[SOURCE_ID]).toEqual(projectedManifest.bindings[SOURCE_ID]?.backing);
    expect(hydrated.__root__?.[SOURCE_ID]).toMatchObject({
      extensionScope: {
        sourceRoot: join(snapshotSourceRoot, "packages", "extension"),
      },
      sourcePath: join(snapshotSourceRoot, "packages", "extension", "agent.ts"),
    });
  });

  it("keeps original lazy loaders in one runtime-relative wrapper", () => {
    const runtimeAppRoot = "/snapshots/generation/source/app";
    const sourceManifest = createSourceManifest();
    const projectedManifest = createRelocatedManifest({
      runtimeAppRoot,
      snapshotSourceRoot: "/snapshots/generation/source",
      sourceManifest,
    });
    const bundleEntry = createGenerationModuleMapBundleEntry({
      moduleMapPath: "/workspace/apps/agent/.eve/compile/module-map.mjs",
      moduleMapSource: "export default sourceDescriptor;",
      projection: { manifest: projectedManifest, runtimeAppRoot },
      sourceManifest,
    });
    const loaded = (
      bundleEntry.plugin as {
        load(id: string): { readonly code: string } | undefined;
      }
    ).load(bundleEntry.inputPath);
    const materializedPath = join(
      runtimeAppRoot,
      ".eve",
      "compile",
      "authored-modules",
      `${"a".repeat(64)}.mjs`,
    );
    const calculatedRuntimeRoot = fileURLToPath(
      new URL("../../../", pathToFileURL(materializedPath)),
    );

    expect(resolve(calculatedRuntimeRoot)).toBe(runtimeAppRoot);
    expect(loaded?.code).toContain(
      'import sourceDescriptor from "/workspace/apps/agent/.eve/compile/module-map.mjs";',
    );
    expect(loaded?.code).toContain("...loader");
    expect(loaded?.code).toContain("export function createModuleMapDescriptor(runtimeAppRoot)");
    expect(loaded?.code).toContain('new URL("../../../", import.meta.url)');
    expect(loaded?.code).not.toContain(runtimeAppRoot);
  });

  it("rejects any projection that changes non-path backing semantics", () => {
    const runtimeAppRoot = "/snapshots/generation/source/app";
    const sourceManifest = createSourceManifest();
    const projectedManifest = createRelocatedManifest({
      runtimeAppRoot,
      snapshotSourceRoot: "/snapshots/generation/source",
      sourceManifest,
    });
    const binding = projectedManifest.bindings[SOURCE_ID]!;
    if (binding.backing.kind !== "filesystem") throw new Error("Expected filesystem backing.");
    const backing = binding.backing;
    const malformed: CompiledAgentManifest = {
      ...projectedManifest,
      bindings: {
        ...projectedManifest.bindings,
        [SOURCE_ID]: {
          ...binding,
          backing: {
            ...backing,
            externalDependencies: ["different-runtime"],
          },
        },
      },
    };

    expect(() =>
      createGenerationModuleMapBackingProjection({
        projectedManifest: malformed,
        runtimeAppRoot,
        sourceManifest,
      }),
    ).toThrow("non-path backing semantics changed");
  });
});
