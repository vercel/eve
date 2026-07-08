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

  it("selects Workflow's installed local and Vercel world packages by environment", () => {
    expect(createWorkflowWorldPluginSource(undefined)).toContain("@workflow/world-local");

    process.env.VERCEL_DEPLOYMENT_ID = "deployment-id";

    expect(createWorkflowWorldPluginSource(undefined)).toContain("@workflow/world-vercel");
  });
});
