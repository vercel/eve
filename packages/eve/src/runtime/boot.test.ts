import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import { bootEve } from "#runtime/boot.js";

const BUILD_DEPLOYMENT_ID = "eve_0123456789abcdef0123456789abcdef";
const STOP = new Error("stop before the World is installed");

function readWorkflowEnvironment() {
  return {
    deploymentId: process.env.WORKFLOW_DEPLOYMENT_ID,
    specVersion: process.env.WORKFLOW_SPEC_VERSION,
  };
}

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  for (const name of [
    "VERCEL",
    "VERCEL_DEPLOYMENT_ID",
    "WORKFLOW_DEPLOYMENT_ID",
    "WORKFLOW_SPEC_VERSION",
    "WORKFLOW_SEALED_LOG",
  ]) {
    vi.stubEnv(name, undefined);
  }
});

describe("bootEve", () => {
  it("configures the Workflow environment before it creates a World eve owns", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      bootEve({
        workflowEnvironment: { buildDeploymentId: BUILD_DEPLOYMENT_ID },
        createWorld() {
          seen = readWorkflowEnvironment();
          throw STOP;
        },
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({
      deploymentId: BUILD_DEPLOYMENT_ID,
      specVersion: String(EVE_WORKFLOW_SPEC_VERSION),
    });
  });

  it("leaves the Workflow environment alone for a parent-backed World", async () => {
    let seen: ReturnType<typeof readWorkflowEnvironment> | undefined;

    await expect(
      bootEve({
        createWorld() {
          seen = readWorkflowEnvironment();
          throw STOP;
        },
      }),
    ).rejects.toBe(STOP);

    expect(seen).toEqual({ deploymentId: undefined, specVersion: undefined });
  });
});
