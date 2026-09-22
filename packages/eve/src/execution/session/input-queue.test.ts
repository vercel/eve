import { describe, expect, it } from "vitest";
import type { DeliverHookPayload } from "#channel/types.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";

const cohorts = new Map([
  ["cancelled-task", "siblings"],
  ["other-task", "siblings"],
]);
const lifecycle: DeliverHookPayload = {
  kind: "deliver",
  taskDeliveryId: "cancelled-task:ready:completed",
  payloads: [
    {
      message: "Late completion",
      task: {
        views: [
          {
            taskId: "cancelled-task",
            status: "completed",
            lastOutput: { type: "result", data: "done" },
            metadata: { kind: "subagent", name: "worker" },
          },
        ],
      },
    },
  ],
};
const notification: DeliverHookPayload = {
  ...lifecycle,
  payloads: [{ message: "Late completion" }],
};
const update: DeliverHookPayload = {
  ...notification,
  taskDeliveryId: "cancelled-task:update:1",
};
const other: DeliverHookPayload = {
  kind: "deliver",
  taskDeliveryId: "other-task:ready:completed",
  payloads: [{ message: "Other task finished" }],
};

describe.each(["auto", "cohort"] as const)(
  "cancelled task delivery with %s policy",
  (taskDeliveryPolicy) => {
    it.each(["before", "after"])(
      "preserves settlement when cancellation arrives %s the report",
      (timing) => {
        const queue = new SessionInputQueue();
        if (timing === "before") queue.cancelTask("cancelled-task");
        const admission = queue.enqueueDelivery(lifecycle)!;
        queue.enqueueDelivery(update);
        if (timing === "after") queue.cancelTask("cancelled-task");

        expect(queue.taskDeliveries()).toMatchObject([admission]);
        expect(queue.pendingCount).toBe(1);
        expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toBeUndefined();
        queue.replaceDelivery(admission.sequence, notification);
        expect(queue.pendingCount).toBe(0);
        expect(queue.enqueueDelivery(update)).toBeUndefined();
      },
    );

    it("does not coalesce a cancelled sibling or discard its unprocessed settlement", () => {
      const queue = new SessionInputQueue();
      queue.cancelTask("cancelled-task");
      queue.enqueueDelivery(other);
      const cancelled = queue.enqueueDelivery(lifecycle)!;

      expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toMatchObject({
        kind: "turn",
        delivery: other,
      });
      expect(queue.taskDeliveries()).toMatchObject([cancelled]);
      expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toBeUndefined();
    });

    it("preserves cancellation after handoff while allowing user input and other tasks", () => {
      const previous = new SessionInputQueue();
      previous.cancelTask("cancelled-task");
      const queue = new SessionInputQueue(
        JSON.parse(JSON.stringify(previous.getCancelledTaskIds())),
      );
      expect(queue.enqueueDelivery(notification)).toBeUndefined();
      const user: DeliverHookPayload = { kind: "deliver", payloads: [{ message: "New request" }] };
      queue.enqueueDelivery(user);
      queue.enqueueDelivery(other);
      expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toMatchObject({ delivery: user });
      expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toMatchObject({ delivery: other });
    });

    it("allows ordinary task cancellation receipts to notify the model", () => {
      const queue = new SessionInputQueue();
      const receipt: DeliverHookPayload = {
        ...notification,
        taskDeliveryId: "cancelled-task:ready:cancelled",
      };
      queue.enqueueDelivery(receipt);
      queue.enqueueDelivery(other);
      expect(queue.takeNext(cohorts, { taskDeliveryPolicy })).toMatchObject({
        kind: "turn",
        delivery: { taskDeliveryIds: [receipt.taskDeliveryId, other.taskDeliveryId] },
      });
    });
  },
);
