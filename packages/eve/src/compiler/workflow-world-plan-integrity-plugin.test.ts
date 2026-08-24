import { describe, expect, it, vi } from "vitest";

import { createWorkflowWorldPlanIntegrityPlugin } from "#compiler/workflow-world-plan-integrity-plugin.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";

describe("createWorkflowWorldPlanIntegrityPlugin", () => {
  it("guards both boundaries of the host bundle", async () => {
    const assertIntegrity = vi.fn(async () => undefined);
    const plugin = createWorkflowWorldPlanIntegrityPlugin({
      assertIntegrity,
      plan: { kind: "native", selection: "host-default", target: "local" },
    }) as {
      readonly buildEnd: () => Promise<void>;
      readonly buildStart: () => Promise<void>;
    };

    await plugin.buildStart();
    await plugin.buildEnd();

    expect(assertIntegrity).toHaveBeenCalledTimes(2);
  });

  it("rejects package imports outside the compiled dependency graph", () => {
    const plan = {
      backing: {
        entryPackageId: "root",
        entryPath: "/bound/root/index.js",
        identitySha256: "0".repeat(64),
        mode: "materialized",
        packages: [
          {
            contentSha256: "1".repeat(64),
            dependencies: {
              "bound-dependency": "root>bound-dependency",
              "missing-optional": null,
            },
            id: "root",
            manifestPath: "/bound/root/package.json",
            name: "@acme/world",
            rootPath: "/bound/root",
            sourceManifestPath: "/source/root/package.json",
            sourceRootPath: "/source/root",
            version: "1.0.0",
          },
          {
            contentSha256: "2".repeat(64),
            dependencies: {},
            id: "root>bound-dependency",
            manifestPath: "/bound/dependency/package.json",
            name: "bound-dependency",
            rootPath: "/bound/dependency",
            sourceManifestPath: "/source/dependency/package.json",
            sourceRootPath: "/source/dependency",
            version: "1.0.0",
          },
        ],
      },
      kind: "host-module",
      packageName: "@acme/world",
      protocol: {
        declaredPackageName: "@workflow/core",
        declaredRange: "^5.0.0-beta.43",
        expectedVersion: "5.0.0-beta.43",
      },
      selection: "configured",
    } as const satisfies CompiledWorkflowWorldPlan;
    const plugin = createWorkflowWorldPlanIntegrityPlugin({
      assertIntegrity: vi.fn(async () => undefined),
      plan,
    }) as { readonly resolveId: (source: string, importer?: string) => null };

    expect(plugin.resolveId("bound-dependency/subpath", "/bound/root/index.js")).toBeNull();
    expect(plugin.resolveId("node:fs", "/bound/root/index.js")).toBeNull();
    expect(() => plugin.resolveId("undeclared", "/bound/root/index.js")).toThrow(
      "imports undeclared package",
    );
    expect(plugin.resolveId("missing-optional", "/bound/root/index.js")).toBeNull();
  });
});
