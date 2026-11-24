import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EVE_WORKFLOW_SPEC_VERSION } from "#internal/workflow/spec-version-default.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";
import { bootEve } from "#runtime/boot.js";
import { createEveRuntime, installEveRuntime } from "#runtime/eve-runtime.js";

const BUILD_DEPLOYMENT_ID = "eve_0123456789abcdef0123456789abcdef";
const STOP = new Error("stop before the World is installed");

function readWorkflowEnvironment() {
  return {
    deploymentId: process.env.WORKFLOW_DEPLOYMENT_ID,
    specVersion: process.env.WORKFLOW_SPEC_VERSION,
  };
}

let uninstallRuntime: (() => void) | undefined;

afterEach(() => {
  uninstallRuntime?.();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  const runtime = createEveRuntime();
  runtime.platform = createVercelPlatformContext();
  uninstallRuntime = installEveRuntime(runtime);
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

  it("refuses to boot the World before the platform is installed", async () => {
    uninstallRuntime?.();
    uninstallRuntime = installEveRuntime(createEveRuntime());

    await expect(bootEve({ createWorld: () => Promise.reject(STOP) })).rejects.toThrow(
      "before installing its platform",
    );
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
