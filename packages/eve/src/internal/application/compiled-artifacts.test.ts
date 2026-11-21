import { describe, expect, it } from "vitest";

const BUILD_DEPLOYMENT_ID =
  'workflowEnvironment: { buildDeploymentId: "eve_BUILD_DEPLOYMENT_ID_PLACEHOLDER_" }';

import {
  createDevelopmentWorkflowWorldPluginSource,
  createWorkflowWorldPluginSource,
} from "#internal/application/compiled-artifacts.js";

describe("createWorkflowWorldPluginSource", () => {
  it("imports a configured world package and delegates its construction to Workflow", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/compiled-artifacts-bootstrap.mjs",
      configuredWorld: "@acme/eve-world",
      defaultWorld: "vercel",
    });

    expect(source).toContain('import "/app/.eve/compile/compiled-artifacts-bootstrap.mjs";');
    expect(source).toContain('import * as workflowWorldModule from "@acme/eve-world";');
    expect(source).toContain("import { bootEve } from ");
    expect(source).toContain("export const eveRuntime = await bootEve({");
    expect(source).toContain('configuredWorld: "@acme/eve-world",');
    expect(source).toContain(BUILD_DEPLOYMENT_ID);
    expect(source).toContain(
      "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
    );
    expect(source).not.toContain("resolveLocalWorkflowWorldDataDirectory");
  });

  it("configures the vendored local World with eve's app-local data resolver", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/bootstrap.mjs",
      configuredWorld: undefined,
      defaultWorld: "local",
    });

    expect(source).toContain("/compiled/@workflow/world-local/index.js");
    expect(source).toContain("resolveLocalWorkflowWorldDataDirectory(process.cwd())");
    expect(source).toContain("applyLocalWorkflowWorldDeliveryTimeoutDefaults");
    expect(source).toContain("recoverActiveRuns: true");
    expect(source).toContain("assertLocalWorkflowQueueAuthEnforced();");
    expect(source.indexOf("assertLocalWorkflowQueueAuthEnforced();")).toBeLessThan(
      source.indexOf("workflowWorldModule.createWorld"),
    );
    expect(source.indexOf("applyLocalWorkflowWorldDeliveryTimeoutDefaults();")).toBeLessThan(
      source.indexOf("workflowWorldModule.createWorld"),
    );
    expect(source).not.toContain("createWorldFromModule(workflowWorldModule)");
    expect(source).toContain(BUILD_DEPLOYMENT_ID);
  });

  it("selects the vendored Vercel World with Workflow's selector", () => {
    const source = createWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/compile/bootstrap.mjs",
      configuredWorld: undefined,
      defaultWorld: "vercel",
    });

    expect(source).toContain("/compiled/@workflow/world-vercel/index.js");
    expect(source).toMatch(/headers: \{ "User-Agent": "eve\/.+" \}/);
    expect(source).not.toContain("authenticateLocalWorkflowDeliveries");
    expect(source).toContain(BUILD_DEPLOYMENT_ID);
  });
});

describe("createDevelopmentWorkflowWorldPluginSource", () => {
  it("installs the parent-backed World without starting a local World in the worker", () => {
    const source = createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/host/bootstrap.mjs",
      configuredWorld: undefined,
    });

    expect(source).toContain(
      "export const eveRuntime = await bootEve({ createWorld: () => createDevelopmentWorkflowWorld() });",
    );
    expect(source).not.toContain("workflowEnvironment");
    expect(source).not.toContain("@workflow/world-local");
  });

  it("keeps explicitly configured remote Worlds inside the worker", () => {
    const source = createDevelopmentWorkflowWorldPluginSource({
      compiledArtifactsBootstrapPath: "/app/.eve/host/bootstrap.mjs",
      configuredWorld: "@acme/eve-world",
    });

    expect(source).toContain('import * as workflowWorldModule from "@acme/eve-world";');
    expect(source).toContain('configuredWorld: "@acme/eve-world",');
  });
});
