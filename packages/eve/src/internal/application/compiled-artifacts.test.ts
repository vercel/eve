import { afterEach, describe, expect, it } from "vitest";

import { createWorkflowWorldPluginSource } from "#internal/application/compiled-artifacts.js";

describe("createWorkflowWorldPluginSource", () => {
  afterEach(() => {
    delete process.env.VERCEL_DEPLOYMENT_ID;
    delete process.env.WORKFLOW_TARGET_WORLD;
  });

  it("imports a configured world package and delegates its construction to Workflow", () => {
    const source = createWorkflowWorldPluginSource("@acme/eve-world");

    expect(source).toContain('import * as workflowWorldModule from "@acme/eve-world";');
    expect(source).toContain("setWorld(await createWorldFromModule(workflowWorldModule));");
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
