import { describe, expect, it } from "vitest";

import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";

describe("createAgentModuleNamespaceLoader", () => {
  it("rejects configured filesystem bindings without a compiler plan session", async () => {
    const loader = createAgentModuleNamespaceLoader();

    await expect(
      loader.load({
        externalDependencies: ["fixture-runtime"],
        kind: "filesystem",
        sourcePath: "/app/agent/tools/read.ts",
      }),
    ).rejects.toThrow("requires the compiler-selected external dependency plan");
  });

  it("loads the exact immutable namespace from an explicit registry", async () => {
    const definition = { execute: () => "ok" };
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.defaults",
          revision: "test-revision",
          modules: [
            { logicalPath: "tools/read.ts", loadNamespace: () => ({ default: definition }) },
          ],
        }),
      },
    ]);
    const loader = createAgentModuleNamespaceLoader({ registry });

    await expect(
      loader.load({
        kind: "programmatic",
        moduleId: "tools/read.ts",
        registryId: "eve.defaults",
        revision: "test-revision",
      }),
    ).resolves.toEqual({ default: definition });
  });

  it("never probes disk when a programmatic binding is absent", async () => {
    const loader = createAgentModuleNamespaceLoader({ registry: createAgentSourceRegistry([]) });

    await expect(
      loader.load({
        kind: "programmatic",
        moduleId: "tools/missing.ts",
        registryId: "missing",
        revision: "test-revision",
      }),
    ).rejects.toThrow('Programmatic module binding "missing:tools/missing.ts" is not registered');
  });

  it("rejects a same-key binding from a different registered revision before evaluation", async () => {
    let loads = 0;
    const loader = createAgentModuleNamespaceLoader({
      registry: createAgentSourceRegistry([
        {
          applyTo: "root",
          source: defineProgrammaticAgentSource({
            id: "eve.defaults",
            modules: [
              {
                loadNamespace() {
                  loads += 1;
                  return { default: { execute: () => "second" } };
                },
                logicalPath: "tools/read.ts",
              },
            ],
            revision: "second-revision",
          }),
        },
      ]),
    });

    await expect(
      loader.load({
        kind: "programmatic",
        moduleId: "tools/read.ts",
        registryId: "eve.defaults",
        revision: "first-revision",
      }),
    ).rejects.toThrow('requires revision "first-revision"');
    expect(loads).toBe(0);
  });

  it("rejects a persisted module semantic revision mismatch before evaluation", async () => {
    let loads = 0;
    const loader = createAgentModuleNamespaceLoader({
      registry: createAgentSourceRegistry([
        {
          applyTo: "root",
          source: defineProgrammaticAgentSource({
            id: "eve.defaults",
            modules: [
              {
                loadNamespace() {
                  loads += 1;
                  return { default: {} };
                },
                logicalPath: "sandbox.ts",
                semanticRevision: "registered-v1",
              },
            ],
            revision: "source-revision",
          }),
        },
      ]),
    });

    await expect(
      loader.load({
        kind: "programmatic",
        moduleId: "sandbox.ts",
        registryId: "eve.defaults",
        revision: "source-revision",
        semanticRevision: "persisted-v2",
      }),
    ).rejects.toThrow('requires semantic revision "persisted-v2"');
    expect(loads).toBe(0);
  });

  it("feeds a programmatic export through ordinary definition materialization", async () => {
    const definition = () => ({ description: "Reads a file." });
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.materialization",
          revision: "test-revision",
          modules: [
            { logicalPath: "tools/read.ts", loadNamespace: () => ({ default: definition }) },
          ],
        }),
      },
    ]);

    await expect(
      loadModuleBackedDefinition({
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "tools/read.ts",
            registryId: "eve.materialization",
            revision: "test-revision",
          },
          logicalPath: "tools/read.ts",
          owner: { feature: "test", kind: "framework" },
        },
        kind: "tool",
        moduleLoader: createAgentModuleNamespaceLoader({ registry }),
        source: {
          logicalPath: "tools/read.ts",
          sourceId: "eve.materialization:tools/read.ts",
          sourceKind: "module",
        },
      }),
    ).resolves.toEqual({ description: "Reads a file." });
  });
});
