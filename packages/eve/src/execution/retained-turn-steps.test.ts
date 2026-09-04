import { afterEach, describe, expect, it, vi } from "vitest";

import { prepareRetainedTurnStep, startRetainedTurnStep } from "./retained-turn-steps.js";
import type { TurnWorkflowInput } from "./durable-session-migrations/turn-workflow.js";
import { startWorkflowOnAcceptedDeployment, turnWorkflowReference } from "./workflow-runtime.js";

const { world } = vi.hoisted(() => ({
  world: { runs: { get: vi.fn() }, createRunId: vi.fn(() => "01ARZ3NDEKTSV4RRFFQ69G5FAV") },
}));
vi.mock("#internal/workflow/runtime.js", () => ({ getWorld: async () => world }));
vi.mock("./workflow-runtime.js", () => ({
  startWorkflowOnAcceptedDeployment: vi.fn(),
  turnWorkflowReference: { workflowId: "workflow//eve//turnWorkflow" },
}));

describe("retained turn dispatch", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("prepares the original deployment and a World-compatible run ID without starting it", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_new");
    world.runs.get.mockResolvedValue({ deploymentId: "dpl_old" });

    await expect(prepareRetainedTurnStep("wrun_parent")).resolves.toEqual({
      deploymentId: "dpl_old",
      runId: "wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    });
    expect(world.runs.get).toHaveBeenCalledWith("wrun_parent", { resolveData: "none" });
    expect(world.createRunId).toHaveBeenCalledWith({ deploymentId: "dpl_old" });
    expect(startWorkflowOnAcceptedDeployment).not.toHaveBeenCalled();
  });

  it("does not forward a turn already on its parent's deployment", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_old");
    world.runs.get.mockResolvedValue({ deploymentId: "dpl_old" });
    await expect(prepareRetainedTurnStep("wrun_parent")).resolves.toBeUndefined();
    expect(world.createRunId).not.toHaveBeenCalled();
  });

  it("does not claim retained-artifact routing on self-hosted Worlds", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "");
    await expect(prepareRetainedTurnStep("wrun_parent")).resolves.toBeUndefined();
    expect(world.runs.get).not.toHaveBeenCalled();
  });

  it("reuses its persisted run ID and exact old input on every start attempt", async () => {
    const target = { deploymentId: "dpl_old", runId: "wrun_01ARZ3NDEKTSV4RRFFQ69G5FAV" };
    const raw = { old: "input", state: { "eve.tasks": { tasks: [] } } };
    const input = {
      stepInput: { sessionState: { sessionId: "wrun_parent" }, serializedContext: {} },
    } as TurnWorkflowInput;
    await startRetainedTurnStep(target, raw, input);
    await startRetainedTurnStep(target, raw, input);

    for (const call of vi.mocked(startWorkflowOnAcceptedDeployment).mock.calls) {
      expect(call.slice(0, 3)).toEqual([turnWorkflowReference, [raw], "dpl_old"]);
      expect(call[1][0]).toBe(raw);
      expect(call[3]?.world?.createRunId?.()).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    }
    expect(startWorkflowOnAcceptedDeployment).toHaveBeenCalledTimes(2);
    expect(world.createRunId).not.toHaveBeenCalled();
  });
});
