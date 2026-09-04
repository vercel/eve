import { expect, it, vi } from "vitest";

import { legacySessionDeliveryWorkflow } from "#internal/testing/legacy-session-delivery-workflow.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, getWorld, resumeHook, setWorld } from "#internal/workflow/runtime.js";
import { createUlid } from "#shared/ulid.js";
import type { TurnWorkflowInput } from "#execution/durable-session-migrations/turn-workflow.js";
import { startRetainedTurnStep } from "#execution/retained-turn-steps.js";

vi.mock("#execution/workflow-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#execution/workflow-runtime.js")>();
  const { legacySessionDeliveryWorkflow } =
    await import("#internal/testing/legacy-session-delivery-workflow.js");
  return { ...actual, turnWorkflowReference: legacySessionDeliveryWorkflow };
});

it("retains one execution after a lost start acknowledgement and a retry after completion", async () => {
  const world = await getWorld();
  const target = { deploymentId: await world.getDeploymentId(), runId: `wrun_${createUlid()}` };
  const token = `retained-turn:${target.runId}`;
  let loseAcknowledgement = true;
  setWorld({
    ...world,
    async queue(...args: Parameters<typeof world.queue>) {
      const result = await world.queue(...args);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("lost start acknowledgement");
      }
      return result;
    },
  });
  const input = {
    stepInput: { sessionState: { sessionId: "wrun_parent" }, serializedContext: {} },
  } as TurnWorkflowInput;
  const run = getRun<string>(target.runId);
  try {
    await expect(startRetainedTurnStep(target, { token }, input)).rejects.toThrow(
      "lost start acknowledgement",
    );
    await startRetainedTurnStep(target, { token }, input);
    await waitForHook({ runId: target.runId }, { token });
    await resumeHook(token, {
      kind: "deliver",
      payloads: [{ message: "completed once" }],
      requestId: "once",
    });
    await expect(run.returnValue).resolves.toBe("completed once");

    await startRetainedTurnStep(target, { token }, input);
    await expect(run.returnValue).resolves.toBe("completed once");
    const workflowName = Reflect.get(legacySessionDeliveryWorkflow, "workflowId");
    if (typeof workflowName !== "string") throw new Error("Fixture workflow metadata is missing.");
    const runs = await world.runs.list({
      workflowName,
      resolveData: "none",
    });
    expect(runs.data.filter((entry) => entry.runId === target.runId)).toHaveLength(1);
    expect(runs.data).toHaveLength(1);
  } finally {
    setWorld(world);
    if ((await run.status) !== "completed") await run.cancel();
  }
});
