import { afterEach, describe, expect, it, vi } from "vitest";

import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

const world = vi.hoisted(() => ({ getDeploymentId: vi.fn(), runs: { get: vi.fn() } }));
vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: async () => world }));

import { findWorkflowRun, workflowDeploymentId } from "#execution/workflow-host/host.js";
import { definePlatform } from "#platform/declaration.js";
import { createEntities } from "#platform/entities.js";

function platformWithDeploymentId(deploymentId: string | undefined) {
  return createEntities(
    definePlatform({
      deployment: () => ({
        environment: () => undefined,
        deploymentId: () => deploymentId,
        productionHost: () => undefined,
        publicHost: () => undefined,
        scope: () => undefined,
      }),
    }),
    undefined,
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("the Workflow engine", () => {
  it("reads a run as eve's Workflow run", async () => {
    const createdAt = new Date("2026-11-20T00:00:00.000Z");
    world.runs.get.mockResolvedValue({
      attributes: { owner: "alice" },
      createdAt,
      expiredAt: undefined,
      input: ["not part of eve's run"],
      runId: "wrun_1",
      status: "running",
    });

    await expect(findWorkflowRun("wrun_1")).resolves.toEqual({
      attributes: { owner: "alice" },
      createdAt,
      expiredAt: undefined,
      runId: "wrun_1",
      status: "running",
    });
  });

  it("finds no run when Workflow has none or its data expired", async () => {
    world.runs.get.mockRejectedValueOnce(new WorkflowRunNotFoundError("wrun_gone"));
    await expect(findWorkflowRun("wrun_gone")).resolves.toBeUndefined();

    world.runs.get.mockRejectedValueOnce(new RunExpiredError("Run data expired.", "wrun_old"));
    await expect(findWorkflowRun("wrun_old")).resolves.toBeUndefined();
  });

  it("surfaces any other failure to read a run", async () => {
    world.runs.get.mockRejectedValue(new Error("the World is down"));

    await expect(findWorkflowRun("wrun_1")).rejects.toThrow("the World is down");
  });

  it("prefers the platform's deployment id over the World's", async () => {
    world.getDeploymentId.mockResolvedValue("dpl_world");
    await expect(workflowDeploymentId(platformWithDeploymentId(undefined))).resolves.toBe(
      "dpl_world",
    );
    await expect(workflowDeploymentId(platformWithDeploymentId("dpl_platform"))).resolves.toBe(
      "dpl_platform",
    );
  });
});
