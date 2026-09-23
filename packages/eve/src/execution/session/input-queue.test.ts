import { describe, expect, it } from "vitest";
import type { DeliverHookPayload } from "#channel/types.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { recordWorkflowTaskView, registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { SessionStateMap } from "#harness/types.js";

function tasks() {
  let session = createTestSessionState({}).snapshot.session;
  for (const taskId of ["first", "second"]) {
    session = registerWorkflowToolRun(session, {
      callId: taskId,
      toolName: "worker",
      lifetime: "session",
      origin: { turnId: "turn-1", stepIndex: 0 },
      address: { runId: `${taskId}-run`, hookToken: `${taskId}-inbox` },
      task: {
        taskId,
        cohortId: "siblings",
        metadata: { kind: "subagent", name: "worker" },
        dispatchContext: { auth: { current: null, initiator: null } },
      },
    });
  }
  return session.state;
}

function settle(
  state: SessionStateMap | undefined,
  taskId: string,
  status: "completed" | "cancelled",
) {
  return recordWorkflowTaskView(state, {
    taskId,
    metadata: { kind: "subagent", name: "worker" },
    ...(status === "cancelled"
      ? { status }
      : { status, lastOutput: { type: "result", data: "done" } }),
  }).state;
}

const first: DeliverHookPayload = {
  kind: "deliver",
  taskDeliveryId: "first:ready:completed",
  payloads: [{ message: "First finished" }],
};
const second: DeliverHookPayload = {
  kind: "deliver",
  taskDeliveryId: "second:ready:completed",
  payloads: [{ message: "Second finished" }],
};
const user: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "New request" }] };

describe.each(["auto", "cohort"] as const)(
  "task notifications with %s delivery",
  (taskDeliveryPolicy) => {
    it("discards an already queued completion during cancellation without changing its outcome", () => {
      const queue = new SessionInputQueue();
      let state = settle(tasks(), "first", "completed");
      queue.enqueueDelivery(first);
      state = settle(state, "second", "cancelled");
      queue.discardStaleNotifications(state);
      expect(queue.takeNext(state, { taskDeliveryPolicy })).toBeUndefined();
      expect(queue.pendingCount).toBe(0);
    });

    it("uses restored outcomes to reject late model notifications while retaining settlement", () => {
      const state = JSON.parse(JSON.stringify(settle(tasks(), "first", "cancelled")));
      const queue = new SessionInputQueue();
      expect(queue.enqueueDelivery(first, state)).toBeUndefined();
      expect(
        queue.enqueueDelivery({ ...first, taskDeliveryId: "first:update:1" }, state),
      ).toBeUndefined();
      const settlement: DeliverHookPayload = {
        ...first,
        payloads: [
          {
            task: {
              views: [
                {
                  taskId: "first",
                  status: "cancelled",
                  metadata: { kind: "subagent", name: "worker" },
                },
              ],
            },
          },
        ],
      };
      const admitted = queue.enqueueDelivery(settlement, state);
      expect(admitted).toBeDefined();
      queue.discardStaleNotifications(state);
      expect(queue.taskDeliveries()).toMatchObject([admitted]);
      queue.replaceDelivery(admitted!.sequence, undefined);
      queue.enqueueDelivery(user, state);
      expect(queue.takeNext(state, { taskDeliveryPolicy })).toMatchObject({ delivery: user });
    });

    it("preserves updates and results for a worker whose cancellation failed", () => {
      const queue = new SessionInputQueue();
      const state = settle(tasks(), "first", "cancelled");
      const update = { ...second, taskDeliveryId: "second:update:1" };
      queue.enqueueDelivery(update, state);
      queue.discardStaleNotifications(state);
      expect(queue.takeNext(state, { taskDeliveryPolicy })).toMatchObject({ delivery: update });
      queue.enqueueDelivery(second, state);
      expect(
        queue.takeNext(settle(state, "second", "completed"), { taskDeliveryPolicy }),
      ).toMatchObject({ delivery: second });
    });

    it("releases a completed sibling without waiting for the cancelled task's duplicate receipt", () => {
      const queue = new SessionInputQueue();
      const state = settle(tasks(), "first", "cancelled");
      queue.enqueueDelivery(second, state);
      expect(
        queue.takeNext(settle(state, "second", "completed"), { taskDeliveryPolicy }),
      ).toMatchObject({ delivery: second });
    });
  },
);
