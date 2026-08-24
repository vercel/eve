import { describe, expect, it } from "vitest";

import {
  createDevelopmentWorkflowWorldPluginSource,
  createWorkflowWorldPluginSource,
} from "#internal/application/compiled-artifacts.js";
import type { CompiledWorkflowWorldPlan } from "#compiler/workflow-world-plan.js";

const CUSTOM_WORLD_PLAN: CompiledWorkflowWorldPlan = {
  backing: {
    entryPackageId: "root",
    entryPath: "/app/node_modules/@acme/eve-world/index.js",
    identitySha256: "0".repeat(64),
    mode: "materialized",
    packages: [],
  },
  kind: "host-module",
  packageName: "@acme/eve-world",
  protocol: {
    declaredPackageName: "@workflow/core",
    declaredRange: "^5.0.0-beta.43",
    expectedVersion: "5.0.0-beta.43",
  },
  selection: "configured",
};

describe("createWorkflowWorldPluginSource", () => {
  it("imports a configured world package and delegates its construction to Workflow", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/compiled-artifacts-bootstrap.mjs",
      worldPlan: CUSTOM_WORLD_PLAN,
    });

    expect(source).toContain('import "/app/.eve/compile/compiled-artifacts-bootstrap.mjs";');
    expect(source).toContain(
      'const workflowWorldModule = await import("/app/node_modules/@acme/eve-world/index.js");',
    );
    expect(source).toContain("import { validateWorkflowWorld } from ");
    expect(source).toContain(
      "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
    );
    expect(source).toContain("validateWorkflowWorld({ world: workflowWorld });");
    expect(source).not.toContain("resolveLocalWorkflowWorldDataDirectory");
    expect(source).toContain("setWorld(workflowWorld);");
    expect(source).toContain("await getWorld();");
    expect(source).toContain("await workflowWorld.start?.();");
  });

  it("configures the vendored local World with eve's app-local data resolver", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/bootstrap.mjs",
      worldPlan: { kind: "native", selection: "host-default", target: "local" },
    });

    expect(source).toContain("/compiled/@workflow/world-local/index.js");
    expect(source).toContain("resolveLocalWorkflowWorldDataDirectory(process.cwd())");
    expect(source).not.toContain("createWorldFromModule(workflowWorldModule)");
  });

  it("selects the vendored Vercel World with Workflow's selector", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/bootstrap.mjs",
      worldPlan: { kind: "native", selection: "host-default", target: "vercel" },
    });

    expect(source).toContain("/compiled/@workflow/world-vercel/index.js");
    expect(source).toMatch(/headers: \{ "User-Agent": "eve\/.+" \}/);
  });
});

describe("createDevelopmentWorkflowWorldPluginSource", () => {
  it("installs the parent-backed World without starting a local World in the worker", () => {
    const source = createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/host/bootstrap.mjs",
      worldPlan: { kind: "native", selection: "host-default", target: "local" },
    });

    expect(source).toContain("createDevelopmentWorkflowWorld");
    expect(source).toContain("setWorld(createDevelopmentWorkflowWorld());");
    expect(source).not.toContain("@workflow/world-local");
    expect(source).not.toContain("workflowWorld.start");
  });

  it("keeps explicitly configured remote Worlds inside the worker", () => {
    const source = createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/host/bootstrap.mjs",
      worldPlan: CUSTOM_WORLD_PLAN,
    });

    expect(source).toContain(
      'const workflowWorldModule = await import("/app/node_modules/@acme/eve-world/index.js");',
    );
    expect(source).toContain("await workflowWorld.start?.();");
  });
});
