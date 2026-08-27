import { describe, expect, it } from "vitest";

import type { SessionStateMap } from "#harness/types.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";
import {
  resolveInitiatingTaskContext,
  resolveTaskDeliveryContext,
  TASK_DELIVERY_CONTEXT_LABEL,
  TASK_DELIVERY_INITIATING_INSTRUCTION,
  TASK_DELIVERY_PENDING_INSTRUCTION,
  TASK_DELIVERY_SETTLED_INSTRUCTION,
} from "#tasks/delivery-context.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";
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

  it("pending instruction unconditionally requires the sentinel", () => {
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(TASK_DELIVERY_CONTEXT_LABEL);
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain("runtime-authored");
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain("still pending");
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      "overrides any earlier instruction to report, summarize, acknowledge",
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      "may call tools only if the newly delivered task result requires immediate action",
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      "Do not provide progress, status, an acknowledgement, or a waiting message",
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      `entire final text response must be exactly ${EMPTY_DELIVERY_SENTINEL} and no other text`,
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(
      'Incorrect: "Two of three tasks have completed."',
    );
    expect(TASK_DELIVERY_PENDING_INSTRUCTION).toContain(`Correct: ${EMPTY_DELIVERY_SENTINEL}`);
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

describe("resolveInitiatingTaskContext", () => {
  it("projects the active turn's accepted background tasks as initiating", async () => {
    expect(
      await resolveInitiatingTaskContext({
        state: taskState([
          taskEntry("task_1", "turn_1", undefined, { data: {}, kind: "subagent" }),
          taskEntry("task_2", "turn_2", undefined, { data: {}, kind: "subagent" }),
        ]),
        turnId: "turn_1",
      }),
    ).toEqual({
      context:
        '[Task state]\n{"tasks":[{"name":"report_probe","status":"pending","taskId":"task_1"}]}',
      phase: "initiating",
      spills: [],
    });
  });

  it("ignores task records that were not accepted by an executor", async () => {
    expect(
      await resolveInitiatingTaskContext({
        state: taskState([taskEntry("task_1", "turn_1")]),
        turnId: "turn_1",
      }),
    ).toBeUndefined();
  });
});

describe("resolveTaskDeliveryContext", () => {
  it("projects terminal and pending siblings from the delivered task's parent turn", async () => {
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

    expect(
      await resolveTaskDeliveryContext({ state, taskDeliveryId: "task_1:ready:completed" }),
    ).toEqual({
      context:
        '[Task state]\n{"tasks":[{"name":"report_probe","status":"completed","taskId":"task_1"},{"name":"report_probe","status":"pending","taskId":"task_2"}]}',
      phase: "pending",
      spills: [],
    });
  });

  it("includes every output once the parent has received the whole terminal cohort", async () => {
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
      await resolveTaskDeliveryContext({
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
      spills: [],
    });
  });

  it("projects terminal output through the configured overflow policy", async () => {
    const sandbox = mockSandbox();
    const completed = {
      lastOutput: { data: { result: "x".repeat(100) }, type: "result" },
      metadata,
      status: "completed",
      taskId: "task_1",
    } satisfies TaskView;

    const result = await resolveTaskDeliveryContext({
      policy: { maxInlineBytes: 32, overflow: "sandbox" },
      sandboxAccess: sandbox.access,
      state: taskState([taskEntry("task_1", "turn_1", completed)]),
      taskDeliveryId: "task_1:ready:completed",
    });

    expect(sandbox.writes).toHaveLength(1);
    expect(result?.context).toContain('"kind":"eve-tool-output-file"');
    expect(result?.context).not.toContain("x".repeat(100));
    expect(result?.spills).toEqual([
      expect.objectContaining({
        callId: "task:task_1",
        maxInlineBytes: 32,
        path: sandbox.writes[0]?.path,
        toolName: "task",
      }),
    ]);
  });

  it("returns no context when the delivery is not owned by the session task index", async () => {
    expect(
      await resolveTaskDeliveryContext({
        state: taskState([taskEntry("task_1", "turn_1")]),
        taskDeliveryId: "task_unknown:ready:completed",
      }),
    ).toBeUndefined();
  });
});

function taskEntry(
  taskId: string,
  createdByTurnId: string,
  terminalView?: TaskView,
  executor?: { readonly data: Record<string, never>; readonly kind: string },
) {
  return {
    createdByTurnId,
    executor,
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
