import { describe, expect, it } from "vitest";

import { isObservedReadyTaskDelivery } from "#tasks/session-index-query.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index-state-key.js";

describe("session task index workflow query", () => {
  const observed = {
    [SESSION_TASKS_STATE_KEY]: {
      tasks: [{ lastPeekedReadyStatus: "completed", taskId: "task_a" }],
    },
  };

  it("suppresses updates and only the matching ready delivery for an observed task", () => {
    expect(isObservedReadyTaskDelivery(observed, "task_a:update:turn:0:call")).toBe(true);
    expect(isObservedReadyTaskDelivery(observed, "task_a:ready:completed")).toBe(true);
    expect(isObservedReadyTaskDelivery(observed, "task_a:ready:failed")).toBe(false);
    expect(isObservedReadyTaskDelivery(observed, "task_b:ready:completed")).toBe(false);
    expect(isObservedReadyTaskDelivery(observed, undefined)).toBe(false);
  });

  it("preserves the wake when no ready status has been observed", () => {
    expect(
      isObservedReadyTaskDelivery(
        { [SESSION_TASKS_STATE_KEY]: { tasks: [{ taskId: "task_a" }] } },
        "task_a:ready:completed",
      ),
    ).toBe(false);
  });

  it.each([
    null,
    {},
    { tasks: null },
    { tasks: [null] },
    { tasks: [undefined] },
    {
      tasks: [{ lastPeekedReadyStatus: "completed", taskId: "task_a" }, null],
    },
    { tasks: [{ lastPeekedReadyStatus: "completed", taskId: "" }] },
    { tasks: [{ lastPeekedReadyStatus: "working", taskId: "task_a" }] },
    { tasks: [{ lastPeekedReadyStatus: "completed", taskId: 42 }] },
  ])("fails open for malformed observation state %#", (taskIndex) => {
    expect(
      isObservedReadyTaskDelivery(
        { [SESSION_TASKS_STATE_KEY]: taskIndex },
        "task_a:ready:completed",
      ),
    ).toBe(false);
  });
});
