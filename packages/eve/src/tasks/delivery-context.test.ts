import { describe, expect, it } from "vitest";

import type { SessionStateMap } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import {
  resolveTaskDeliveryContext,
  TASK_DELIVERY_CONTEXT_LABEL,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";

const metadata = { kind: "report-probe", name: "report_probe" } as const;

describe("task delivery instructions", () => {
  it("pending instruction unconditionally requires the sentinel", () => {
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(TASK_DELIVERY_CONTEXT_LABEL);
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain("runtime-authored");
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain("still pending");
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      `Reply with exactly ${EMPTY_DELIVERY_SENTINEL} and no other text`,
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).not.toContain("If any task");
  });

  it("settled instruction unconditionally forbids the sentinel and requires one combined response", () => {
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).toContain(TASK_DELIVERY_CONTEXT_LABEL);
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).toContain("runtime-authored");
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).toContain("terminal output");
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).toContain(
      `Do not reply with ${EMPTY_DELIVERY_SENTINEL}`,
    );
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).toContain("one user-facing response");
    expect(TASK_DELIVERY_SETTLED_INSTRUCTION).not.toContain("When no task");
  });
});

describe("resolveTaskDeliveryContext", () => {
  it("projects terminal and pending siblings from the delivered task's parent turn", () => {
    const completed = {
      lastOutput: { data: { result: "first" }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task_1",
    } satisfies TaskView;
    const state = taskState([
      taskEntry("task_1", "turn_1", completed),
      taskEntry("task_2", "turn_1"),
      taskEntry("task_3", "turn_2"),
    ]);

    expect(resolveTaskDeliveryContext({ state, taskDeliveryId: "task_1:ready:completed" })).toEqual(
      {
        context:
          '[Task state]\n{"tasks":[{"name":"report_probe","status":"completed","taskId":"task_1"},{"name":"report_probe","status":"pending","taskId":"task_2"}]}',
        phase: "pending",
      },
    );
  });

  it("includes every output once the parent has received the whole terminal cohort", () => {
    const first = {
      lastOutput: { data: { result: "first" }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task_1",
    } satisfies TaskView;
    const second = {
      lastOutput: { data: { result: "second" }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task_2",
    } satisfies TaskView;

    expect(
      resolveTaskDeliveryContext({
        state: taskState([
          taskEntry("task_1", "turn_1", first),
          taskEntry("task_2", "turn_1", second),
        ]),
        taskDeliveryId: "task_2:ready:completed",
      }),
    ).toEqual({
      context:
        '[Task state]\n{"tasks":[{"name":"report_probe","output":{"data":{"result":"first"},"type":"result"},"status":"completed","taskId":"task_1"},{"name":"report_probe","output":{"data":{"result":"second"},"type":"result"},"status":"completed","taskId":"task_2"}]}',
      phase: "settled",
    });
  });

  it("returns no context when the delivery is not owned by the session task index", () => {
    expect(
      resolveTaskDeliveryContext({
        state: taskState([taskEntry("task_1", "turn_1")]),
        taskDeliveryId: "task_unknown:ready:completed",
      }),
    ).toBeUndefined();
  });
});

function taskEntry(taskId: string, createdByTurnId: string, terminalView?: TaskView) {
  return {
    createdByTurnId,
    metadata,
    taskId,
    taskInboxToken: `inbox-${taskId}`,
    taskRunId: `run-${taskId}`,
    terminalView,
  };
}

function taskState(tasks: readonly ReturnType<typeof taskEntry>[]): SessionStateMap {
  return { [SESSION_TASKS_STATE_KEY]: { tasks } } as SessionStateMap;
}
