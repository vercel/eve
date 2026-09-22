import { describe, expect, it } from "vitest";

import type { SessionStateMap } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import {
  getBackgroundTaskDelivery,
  markBackgroundTaskStepInput,
  resolveInitiatingTaskContext,
  resolveTaskDeliveryContext,
  TASK_DELIVERY_CONTEXT_LABEL,
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";
import type { BackgroundWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { TaskView } from "#tasks/types.js";

const metadata = { kind: "report-probe", name: "report_probe" } as const;

describe("task delivery instructions", () => {
  it("initiating instruction requires one launch acknowledgement", () => {
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain(TASK_DELIVERY_CONTEXT_LABEL);
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain("runtime-authored");
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain(
      "continue independently after this turn",
    );
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain(
      "including starting any remaining background work",
    );
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain(
      "When no further tool calls are needed in this turn",
    );
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).toContain("one brief user-facing acknowledgement");
    expect(TASK_DELIVERY_INITIATING_INSTRUCTION).not.toContain(EMPTY_DELIVERY_SENTINEL);
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

describe("getBackgroundTaskDelivery", () => {
  it("recognizes task-owned deliveries independently of their payload", () => {
    expect(
      getBackgroundTaskDelivery({
        kind: "deliver",
        payloads: [{ message: "Background task task_1 completed." }],
        taskDeliveryId: "task_1:ready:completed",
      }),
    ).toMatchObject({ taskDeliveryId: "task_1:ready:completed" });
    expect(getBackgroundTaskDelivery({ kind: "deliver", payloads: [{ message: "Hello." }] })).toBe(
      undefined,
    );
  });

  it("marks task-produced input before delivery results are coalesced", () => {
    expect(markBackgroundTaskStepInput({ message: "Task completed." })).toMatchObject({
      frameworkMessageKind: "execution.background_task",
      message: "Task completed.",
    });
    expect(markBackgroundTaskStepInput({ context: ["Task state"] })).toEqual({
      context: ["Task state"],
    });
  });
});

describe("resolveInitiatingTaskContext", () => {
  it("projects the active turn's accepted background tasks as initiating", () => {
    expect(
      resolveInitiatingTaskContext({
        state: taskState([
          taskEntry("task_1", "turn_1"),
          {
            ...taskEntry("task_2", "turn_2"),
            task: { ...taskEntry("task_2", "turn_2").task, cohortId: "task_1" },
          },
        ]),
        turnId: "turn_1",
      }),
    ).toEqual({
      context:
        '[Task state]\n{"tasks":[{"name":"report_probe","status":"pending","taskId":"task_1"}]}',
      phase: "initiating",
    });
  });

  it("recognizes an indexed invocation without an executor binding", () => {
    expect(
      resolveInitiatingTaskContext({
        state: taskState([taskEntry("task_1", "turn_1")]),
        turnId: "turn_1",
      }),
    ).toMatchObject({ phase: "initiating" });
  });
});

describe("resolveTaskDeliveryContext", () => {
  it("includes completed siblings while a cross-turn cohort is pending", () => {
    const completed = {
      lastOutput: { data: { result: "first" }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task_1",
    } satisfies TaskView;
    const state = taskState([
      taskEntry("task_1", "turn_1", completed),
      {
        ...taskEntry("task_2", "turn_2"),
        task: { ...taskEntry("task_2", "turn_2").task, cohortId: "task_1" },
      },
      taskEntry("task_3", "turn_1"),
    ]);

    expect(resolveTaskDeliveryContext({ state, taskDeliveryId: "task_1:ready:completed" })).toEqual(
      {
        context:
          '[Task state]\n{"tasks":[{"name":"report_probe","status":"completed","taskId":"task_1"},{"name":"report_probe","status":"pending","taskId":"task_2"}]}',
        phase: "pending",
        rootTurnId: "turn_1",
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
          {
            ...taskEntry("task_2", "turn_2", second),
            task: { ...taskEntry("task_2", "turn_2", second).task, cohortId: "task_1" },
          },
        ]),
        taskDeliveryId: "task_2:ready:completed",
      }),
    ).toEqual({
      context:
        '[Task state]\n{"tasks":[{"name":"report_probe","output":{"data":{"result":"first"},"type":"result"},"status":"completed","taskId":"task_1"},{"name":"report_probe","output":{"data":{"result":"second"},"type":"result"},"status":"completed","taskId":"task_2"}]}',
      phase: "settled",
      rootTurnId: "turn_2",
    });
  });

  it("includes failure and cancellation in the terminal cohort, but not an earlier settled report", () => {
    const failed: TaskView = {
      metadata,
      taskId: "task_failed",
      status: "failed",
      lastOutput: { type: "error", data: "Worker failed" },
    };
    const cancelled: TaskView = { metadata, taskId: "task_cancelled", status: "cancelled" };
    const previous: TaskView = {
      metadata,
      taskId: "task_previous",
      status: "completed",
      lastOutput: { type: "result", data: "Already reported" },
    };
    const state = taskState([
      taskEntry("task_previous", "turn_1", previous),
      taskEntry("task_failed", "turn_1", failed),
      {
        ...taskEntry("task_cancelled", "turn_2", cancelled),
        task: { ...taskEntry("task_cancelled", "turn_2", cancelled).task, cohortId: "task_failed" },
      },
    ]);
    const result = resolveTaskDeliveryContext({
      state,
      taskDeliveryId: "task_cancelled:ready:cancelled",
    });
    expect(result).toMatchObject({ phase: "settled", rootTurnId: "turn_2" });
    expect(JSON.parse(result!.context.slice(`${TASK_DELIVERY_CONTEXT_LABEL}\n`.length))).toEqual({
      tasks: [
        { name: metadata.name, output: failed.lastOutput, status: "failed", taskId: "task_failed" },
        { name: metadata.name, status: "cancelled", taskId: "task_cancelled" },
      ],
    });
    expect(result!.context).not.toContain("Already reported");
    expect(result!.context).not.toContain("inbox-");
    expect(result!.context).not.toContain("cohortId");
    expect(result!.context).not.toContain("createdByTurnId");
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

function taskEntry(
  taskId: string,
  createdByTurnId: string,
  outcome?: TaskView,
): BackgroundWorkflowToolRun {
  return {
    callId: taskId,
    toolName: metadata.name,
    lifetime: "session" as const,
    origin: { turnId: createdByTurnId, stepIndex: 0 },
    address: { runId: `run-${taskId}`, hookToken: `inbox-${taskId}` },
    task: {
      dispatchContext: { auth: { current: null, initiator: null } },
      metadata,
      taskId,
      outcome:
        outcome === undefined
          ? undefined
          : {
              status: outcome.status,
              lastOutput: outcome.lastOutput,
              usage: outcome.usage,
            },
    },
  };
}

function taskState(tasks: readonly ReturnType<typeof taskEntry>[]): SessionStateMap {
  return {
    "eve.workflowTool": { version: 3, runs: tasks },
  } as SessionStateMap;
}
