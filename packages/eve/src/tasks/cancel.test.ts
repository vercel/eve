import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTable, taskTableState } from "#internal/testing/task-records.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import { applyTaskCancelCall, cancelTasksStep } from "#tasks/cancel.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import type { TaskRecord } from "#tasks/record.js";
import { renderTasksNote } from "#tasks/render.js";
import {
  encodeTaskCreator,
  holdTaskResult,
  readPendingTaskResults,
  takeTaskResults,
} from "#tasks/results.js";
import { getTaskTable, setTaskTable } from "#tasks/state.js";
import { applyTaskMessage, startTask, type TaskTable } from "#tasks/table.js";
import { settleWorkflowTask } from "#tasks/workflow-task.js";

vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
  logError: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const RUN = { commandToken: "control-hook", kind: "workflow" as const, runId: "run-remind" };
const LOCAL_CHILD = {
  continuationToken: "child-token",
  kind: "local" as const,
  sessionId: "child-session",
};
const REMINDER = createTaskRecord({
  callId: "call-remind",
  child: RUN,
  creator: { auth: null },
  id: "remind-q4x1ze",
  kind: "workflow",
  mode: "background",
  name: "remind",
  turnId: "turn-0",
});

beforeEach(() => {
  vi.mocked(cancelWorkflowToolRun).mockReset();
  vi.mocked(requestWorkflowTurnCancellation).mockReset();
});

describe("applyTaskCancelCall", () => {
  it("cancels a working background task at once and reports it settled", () => {
    const { commands, events, result, table } = applyTaskCancelCall(
      taskTable([REMINDER]),
      call(["remind-q4x1ze"]),
      NOW,
    );

    expect(result).toEqual({
      callId: "call-stop",
      kind: "tool-result",
      output: { alreadyFinished: [], cancelled: ["remind-q4x1ze"], unknown: [] },
      toolName: "task_cancel",
    });
    expect(events).toEqual([
      {
        data: { callId: "call-remind", status: "cancelled", taskId: "remind-q4x1ze" },
        type: "task.settled",
      },
    ]);
    expect(commands).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    expect(table.records).toEqual([
      expect.objectContaining({
        cancelConfirmBy: expect.any(String),
        delivered: true,
        id: "remind-q4x1ze",
        status: "cancelled",
      }),
    ]);
    // Cancelled by its owner, the task leaves the [Tasks] note at once.
    expect(renderTasksNote(table.records)).toBeUndefined();
  });

  it("holds the cancel until the run starts, and the run's late result never reaches the model", () => {
    const unstarted = { ...REMINDER, child: undefined };
    const cancelled = applyTaskCancelCall(taskTable([unstarted]), call(["remind-q4x1ze"]), NOW);

    expect(cancelled.commands).toEqual([]);
    expect(cancelled.table.records[0]).toMatchObject({ pendingCommands: [{ kind: "cancel" }] });
    const started = applyTaskMessage(
      cancelled.table,
      { child: RUN, generation: 1, kind: "task.started", taskId: "remind-q4x1ze" },
      NOW,
    );
    expect(started.effects).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);

    const update = settleWorkflowTask({
      message: {
        from: {
          callId: "call-remind",
          input: {},
          runId: "run-remind",
          sequence: 1,
          stepIndex: 0,
          taskId: "remind-q4x1ze",
          toolName: "remind",
          turnId: "turn-0",
        },
        result: { output: { reminder: "stand-up at 10" }, status: "completed" },
      },
      now: NOW,
      serializedContext: {},
      sessionState: ownerState(started.table.records),
    });

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(readPendingTaskResults(update.sessionState.snapshot.session.state)).toEqual([]);
  });

  it("reports a finished task whose result is pending as already finished, and still delivers it", () => {
    const finished = { ...REMINDER, status: "completed" as const };
    const session = holdTaskResult(
      { sessionId: "parent", state: taskTableState([finished]) },
      finished,
      { output: "Reminder: stand-up at 10", status: "completed" },
    );
    const table = getTaskTable(session);

    const cancelled = applyTaskCancelCall(table, call(["remind-q4x1ze"]), NOW);

    expect(cancelled.result.output).toEqual({
      alreadyFinished: ["remind-q4x1ze"],
      cancelled: [],
      unknown: [],
    });
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.table).toBe(table);
    const { results } = takeTaskResults(setTaskTable(session, cancelled.table), null);
    expect(results).toEqual([expect.objectContaining({ taskId: "remind-q4x1ze" })]);
  });

  it("reports an agent whose result was delivered as already finished", () => {
    const idle = createTaskRecord({
      child: LOCAL_CHILD,
      delivered: true,
      id: "research-7k2m9q",
      status: "completed",
    });

    const { result, table } = applyTaskCancelCall(
      taskTable([idle]),
      call(["research-7k2m9q"]),
      NOW,
    );

    expect(result.output).toEqual({
      alreadyFinished: ["research-7k2m9q"],
      cancelled: [],
      unknown: [],
    });
    expect(table.records).toEqual([idle]);
  });

  it("treats unknown IDs and calls a caller waits on as unknown", () => {
    const waited = createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q" });
    const nested = createTaskRecord({
      callId: "call-nested",
      id: "research-b81d0c",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });
    const initial = taskTable([waited, nested]);

    const cancelled = applyTaskCancelCall(
      initial,
      call(["research-7k2m9q", "research-b81d0c", "nobody-000000"]),
      NOW,
    );

    expect(cancelled.result.output).toEqual({
      alreadyFinished: [],
      cancelled: [],
      unknown: ["research-7k2m9q", "research-b81d0c", "nobody-000000"],
    });
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.table).toBe(initial);
  });

  it("lists a repeated ID once", () => {
    const { events, result } = applyTaskCancelCall(
      taskTable([REMINDER]),
      call(["remind-q4x1ze", "remind-q4x1ze"]),
      NOW,
    );

    expect(result.output).toEqual({
      alreadyFinished: [],
      cancelled: ["remind-q4x1ze"],
      unknown: [],
    });
    expect(events).toHaveLength(1);
  });

  it.each([
    [{}],
    [{ taskIds: "remind-q4x1ze" }],
    [{ taskIds: [] }],
    [{ taskIds: [""] }],
    [{ taskIds: [7] }],
    [{ taskIds: ["x".repeat(129)] }],
    [{ taskIds: Array.from({ length: 51 }, (_, index) => `remind-${String(index)}`) }],
  ])("rejects the input %o without touching the table", (input) => {
    const initial = taskTable([REMINDER]);

    const cancelled = applyTaskCancelCall(
      initial,
      { ...call([]), input: input as JsonObject },
      NOW,
    );

    expect(cancelled.result).toMatchObject({
      isError: true,
      output: { code: "INVALID_INPUT", message: expect.stringContaining("1 to 50") },
    });
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.table).toBe(initial);
  });

  it("stops a task another principal started: access to the session includes cancel rights", () => {
    const alices = {
      ...REMINDER,
      creator: encodeTaskCreator({
        auth: {
          attributes: {},
          authenticator: "slack",
          principalId: "U-alice",
          principalType: "user",
        },
      }),
    };

    // The call runs in Bob's turn; nothing about it names a principal.
    const { result } = applyTaskCancelCall(taskTable([alices]), call(["remind-q4x1ze"]), NOW);

    expect(result.output).toEqual({
      alreadyFinished: [],
      cancelled: ["remind-q4x1ze"],
      unknown: [],
    });
  });

  it("keeps a cancelled agent available for new work", () => {
    const agent = createTaskRecord({
      child: LOCAL_CHILD,
      id: "research-7k2m9q",
      mode: "background",
    });

    const { table } = applyTaskCancelCall(taskTable([agent]), call(["research-7k2m9q"]), NOW);

    expect(renderTasksNote(table.records)).toContain(
      '<agent id="research-7k2m9q" name="research">',
    );
    const continued = startTask(table, {
      agentId: "research-7k2m9q",
      callId: "call-2",
      kind: "agent",
      mode: "foreground",
      name: "research",
      now: NOW,
      ownerId: "parent",
      turnId: "turn-2",
    });
    expect(continued).toMatchObject({
      kind: "started",
      record: { generation: 2, id: "research-7k2m9q", status: "working" },
    });
  });
});

describe("cancelTasksStep with the task selector", () => {
  it("cancels one background task and leaves the turn's calls and other tasks working", async () => {
    const waited = createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q" });
    const other = { ...REMINDER, callId: "call-other", child: undefined, id: "remind-3fq8wd" };

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "task", taskId: "remind-q4x1ze" },
      serializedContext: {},
      sessionState: ownerState([REMINDER, waited, other]),
    });

    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "control-hook", runId: "run-remind" },
      expect.any(String),
    );
    expect(events).toEqual([
      {
        data: { callId: "call-remind", status: "cancelled", taskId: "remind-q4x1ze" },
        type: "task.settled",
      },
    ]);
    expect(records(sessionState).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "remind-q4x1ze", status: "cancelled" },
      { id: "research-7k2m9q", status: "working" },
      { id: "remind-3fq8wd", status: "working" },
    ]);
  });

  it.each([["research-7k2m9q"], ["nobody-000000"]])(
    "ignores %s, a waited call or an unknown ID",
    async (taskId) => {
      const sessionState = ownerState([
        createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q" }),
      ]);

      const update = await cancelTasksStep({
        selector: { kind: "task", taskId },
        serializedContext: {},
        sessionState,
      });

      expect(update.events).toEqual([]);
      expect(update.sessionState).toBe(sessionState);
    },
  );
});

describe("cancelTasksStep with the background selector", () => {
  it("cancels every background task and leaves calls a caller waits on", async () => {
    const waited = createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q" });
    const nested = createTaskRecord({
      callId: "call-nested",
      id: "research-b81d0c",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });
    const detachedAgent = createTaskRecord({
      callId: "call-detached",
      child: { ...LOCAL_CHILD, sessionId: "detached-child" },
      id: "research-3fq8wd",
      mode: "background",
    });

    const { events } = await cancelTasksStep({
      selector: { kind: "background" },
      serializedContext: {},
      sessionState: ownerState([REMINDER, waited, nested, detachedAgent]),
    });

    expect(events.map((event) => event.type === "task.settled" && event.data.taskId)).toEqual([
      "remind-q4x1ze",
      "research-3fq8wd",
    ]);
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "detached-child",
    });
  });
});

function call(taskIds: readonly string[]): RuntimeWorkflowTaskRequest {
  return {
    callId: "call-stop",
    input: { taskIds: [...taskIds] },
    kind: "workflow-task",
    toolName: "task_cancel",
    workflowId: TASK_CANCEL_WORKFLOW_ID,
  };
}

function ownerState(existing: readonly TaskRecord[]): DurableSessionState {
  const base = createTestSessionState({ sessionId: "parent" });
  return {
    ...base,
    snapshot: { session: { ...base.snapshot.session, state: taskTableState(existing) } },
  };
}

function records(state: DurableSessionState): TaskTable["records"] {
  return getTaskTable(state.snapshot.session).records;
}
