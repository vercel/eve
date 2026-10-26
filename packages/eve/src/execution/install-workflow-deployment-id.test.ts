import { afterEach, describe, expect, it, vi } from "vitest";

import { installWorkflowDeploymentId } from "./install-workflow-deployment-id.js";

const id = "eve_0123456789abcdef0123456789abcdef";

afterEach(() => vi.unstubAllEnvs());

describe("installWorkflowDeploymentId", () => {
  it("installs the artifact id before world creation", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", undefined);
    vi.stubEnv("WORKFLOW_DEPLOYMENT_ID", undefined);
    installWorkflowDeploymentId(id);
    expect(process.env.WORKFLOW_DEPLOYMENT_ID).toBe(id);
  });

  it.each([
    ["an operator value", { WORKFLOW_DEPLOYMENT_ID: "operator-supplied" }, id],
    ["Vercel", { VERCEL_DEPLOYMENT_ID: "dpl_platform" }, id],
    ["an unpatched plugin", {}, "eve_BUILD_DEPLOYMENT_ID_PLACEHOLDER_"],
  ])("defers to %s", (_label, env: Record<string, string>, deploymentId) => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", env.VERCEL_DEPLOYMENT_ID);
    vi.stubEnv("WORKFLOW_DEPLOYMENT_ID", env.WORKFLOW_DEPLOYMENT_ID);
    installWorkflowDeploymentId(deploymentId);
    expect(process.env.WORKFLOW_DEPLOYMENT_ID).toBe(env.WORKFLOW_DEPLOYMENT_ID);
  });
});
