import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowWorldPluginSource } from "#internal/application/compiled-artifacts.js";

describe("createWorkflowWorldPluginSource", () => {
  afterEach(() => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  it("imports a configured world package and delegates its construction to Workflow", () => {
    const source = createWorkflowWorldPluginSource(
      "@acme/eve-world",
      "/app/.eve/compile/compiled-artifacts-bootstrap.mjs",
    );

    expect(source).toContain('import "/app/.eve/compile/compiled-artifacts-bootstrap.mjs";');
    expect(source).toContain('import * as workflowWorldModule from "@acme/eve-world";');
    expect(source).toContain("import { validateWorkflowWorld } from ");
    expect(source).toContain(
      "const workflowWorld = await createWorldFromModule(workflowWorldModule);",
    );
    expect(source).toContain(
      'validateWorkflowWorld({ packageName: "@acme/eve-world", world: workflowWorld });',
    );
    expect(source).toContain("setWorld(workflowWorld);");
    expect(source).toContain("await getWorld();");
    expect(source).toContain("await workflowWorld.start?.();");
  });

  it("selects vendored local and Vercel world packages with Workflow's selector", () => {
    expect(createWorkflowWorldPluginSource(undefined)).toContain(
      "/compiled/@workflow/world-local/index.js",
    );

    process.env.VERCEL_DEPLOYMENT_ID = "deployment-id";

    expect(createWorkflowWorldPluginSource(undefined)).toContain(
      "/compiled/@workflow/world-vercel/index.js",
    );
  });
});
