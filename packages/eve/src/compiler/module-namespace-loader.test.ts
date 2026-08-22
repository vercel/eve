import { describe, expect, it } from "vitest";

import { createAgentSourceRegistry } from "#compiler/agent-source-registry.js";
import { createAgentModuleNamespaceLoader } from "#compiler/module-namespace-loader.js";
import { defineProgrammaticAgentSource } from "#compiler/programmatic-agent-source.js";
import { loadModuleBackedDefinition } from "#compiler/normalize-helpers.js";

describe("createAgentModuleNamespaceLoader", () => {
  it("loads the exact immutable namespace from an explicit registry", async () => {
    const definition = { execute: () => "ok" };
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.defaults",
          modules: [{ logicalPath: "tools/read.ts", namespace: { default: definition } }],
        }),
      },
    ]);
    const loader = createAgentModuleNamespaceLoader({ registry });

    await expect(
      loader.load({ kind: "programmatic", moduleId: "tools/read.ts", registryId: "eve.defaults" }),
    ).resolves.toEqual({ default: definition });
  });

  it("never probes disk when a programmatic binding is absent", async () => {
    const loader = createAgentModuleNamespaceLoader({ registry: createAgentSourceRegistry([]) });

    await expect(
      loader.load({ kind: "programmatic", moduleId: "tools/missing.ts", registryId: "missing" }),
    ).rejects.toThrow('Programmatic module binding "missing:tools/missing.ts" is not registered');
  });

  it("feeds a programmatic export through ordinary definition materialization", async () => {
    const definition = () => ({ description: "Reads a file." });
    const registry = createAgentSourceRegistry([
      {
        applyTo: "root",
        source: defineProgrammaticAgentSource({
          id: "eve.materialization",
          modules: [{ logicalPath: "tools/read.ts", namespace: { default: definition } }],
        }),
      },
    ]);

    await expect(
      loadModuleBackedDefinition({
        agentRoot: "/virtual/agent",
        binding: {
          backing: {
            kind: "programmatic",
            moduleId: "tools/read.ts",
            registryId: "eve.materialization",
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
