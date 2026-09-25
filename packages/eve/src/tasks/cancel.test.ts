import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { getPendingCoordinationBatch, setPendingCoordinationBatch } from "#harness/coordination.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { JsonObject } from "#shared/json.js";
import {
  applyTaskCancelCall,
  cancelTasksStep,
  interruptAttachedCalls,
  interruptAttachedCallsStep,
} from "#tasks/cancel.js";
import { TASK_CANCEL_WORKFLOW_ID } from "#tasks/cancel-tool.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  renderTaskOtherPrincipal,
  renderTasksNote,
  renderUnknownTask,
  TASK_CANCEL_INVALID_INPUT_MESSAGE,
} from "#tasks/render.js";
import {
  encodeTaskCreator,
  holdTaskResult,
  readPendingTaskResults,
  takeTaskResults,
} from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { applyTaskMessage, type TaskTable } from "#tasks/table.js";
import { sendTask } from "#tasks/table-generations.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";
import { settleWorkflowTask } from "#tasks/workflow-task.js";

vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn() })),
  logError: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const ALICE = {
  attributes: {},
  authenticator: "slack",
  principalId: "U-alice",
  principalType: "user",
};
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
  mode: "detached",
  name: "remind",
  turnId: "turn-0",
});

beforeEach(() => {
  vi.mocked(cancelWorkflowToolRun).mockReset();
  vi.mocked(requestWorkflowTurnCancellation).mockReset();
});

describe("applyTaskCancelCall", () => {
  it("cancels a working background task at once and reports it settled", () => {
    const { commands, events, results, session } = cancel([REMINDER], "remind-q4x1ze");

    expect(results).toEqual([
      {
        callId: "call-stop",
        kind: "tool-result",
        output: { status: "cancelled" },
        toolName: "task_cancel",
      },
    ]);
    // A workflow tool call is not resumable: it ends with its only generation.
    expect(events).toEqual([
      {
        data: {
          callId: "call-remind",
          generation: 1,
          status: "cancelled",
          taskId: "remind-q4x1ze",
        },
        type: "task.settled",
      },
      { data: { taskId: "remind-q4x1ze" }, type: "task.ended" },
    ]);
    expect(commands).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
    const table = getTaskTable(session);
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
    const cancelled = cancel([unstarted], "remind-q4x1ze");

    expect(cancelled.commands).toEqual([]);
    const table = getTaskTable(cancelled.session);
    expect(table.records[0]).toMatchObject({ pendingCommands: [{ kind: "cancel" }] });
    const started = applyTaskMessage(
      table,
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
          generation: 1,
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

    const cancelled = applyTaskCancelCall({
      caller: null,
      now: NOW,
      request: call("remind-q4x1ze"),
      session,
    });

    expect(cancelled.results.map((result) => result.output)).toEqual([
      { status: "already_finished" },
    ]);
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.session).toBe(session);
    const { results } = takeTaskResults(cancelled.session, null);
    expect(results).toEqual([expect.objectContaining({ taskId: "remind-q4x1ze" })]);
  });

  it("reports an agent whose result was delivered as already finished", () => {
    const idle = createTaskRecord({
      child: LOCAL_CHILD,
      delivered: true,
      id: "research-7k2m9q",
      status: "completed",
    });

    const { results, session } = cancel([idle], "research-7k2m9q");

    expect(results.map((result) => result.output)).toEqual([{ status: "already_finished" }]);
    expect(getTaskTable(session).records).toEqual([idle]);
  });

  it.each([
    ["a call its turn waits on", "research-7k2m9q"],
    ["a call a workflow body awaits", "research-b81d0c"],
    ["an ID the session never had", "nobody-000000"],
  ])("fails UNKNOWN_TASK for %s", (_label, taskId) => {
    const waited = createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q" });
    const nested = createTaskRecord({
      callId: "call-nested",
      id: "research-b81d0c",
      mode: "detached",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });
    const session = { sessionId: "owner", state: taskTableState([waited, nested]) };

    const cancelled = applyTaskCancelCall({
      caller: null,
      now: NOW,
      request: call(taskId),
      session,
    });

    expect(cancelled.results).toEqual([
      {
        callId: "call-stop",
        isError: true,
        kind: "tool-result",
        output: { code: "UNKNOWN_TASK", message: renderUnknownTask(taskId) },
        toolName: "task_cancel",
      },
    ]);
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.session).toBe(session);
  });

  it.each([
    [{}],
    [{ taskId: "" }],
    [{ taskId: 7 }],
    [{ taskId: "x".repeat(129) }],
    [{ taskIds: ["remind-q4x1ze"] }],
  ])("rejects the input %o without touching the table", (input) => {
    const session = { sessionId: "owner", state: taskTableState([REMINDER]) };

    const cancelled = applyTaskCancelCall({
      caller: null,
      now: NOW,
      request: { ...call("remind-q4x1ze"), input: input as JsonObject },
      session,
    });

    expect(cancelled.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: { code: "INVALID_INPUT", message: TASK_CANCEL_INVALID_INPUT_MESSAGE },
      }),
    ]);
    expect(cancelled).toMatchObject({ commands: [], events: [] });
    expect(cancelled.session).toBe(session);
  });

  it("refuses a task another principal started, and lets its creator stop it", () => {
    const alices = { ...REMINDER, creator: encodeTaskCreator({ auth: ALICE }) };
    const session = { sessionId: "owner", state: taskTableState([alices]) };

    const byBob = applyTaskCancelCall({
      caller: { ...ALICE, principalId: "U-bob" },
      now: NOW,
      request: call("remind-q4x1ze"),
      session,
    });
    expect(byBob.results).toEqual([
      expect.objectContaining({
        isError: true,
        output: {
          code: "TASK_OTHER_PRINCIPAL",
          message: renderTaskOtherPrincipal("remind-q4x1ze"),
        },
      }),
    ]);
    expect(byBob.session).toBe(session);
    const anonymous = applyTaskCancelCall({
      caller: null,
      now: NOW,
      request: call("remind-q4x1ze"),
      session,
    });
    expect(anonymous.results[0]).toMatchObject({ output: { code: "TASK_OTHER_PRINCIPAL" } });

    const byAlice = applyTaskCancelCall({
      caller: ALICE,
      now: NOW,
      request: call("remind-q4x1ze"),
      session,
    });
    expect(byAlice.results.map((result) => result.output)).toEqual([{ status: "cancelled" }]);
  });

  it("gives a task_wait on the cancelled task the cancellation as its result", () => {
    const waited = { ...REMINDER, wait: { callId: "call-wait", startedAt: NOW } };
    const session = withBatch(taskTableState([waited]), ["call-wait", "call-stop"]);

    const cancelled = applyTaskCancelCall({
      caller: null,
      now: NOW,
      request: call("remind-q4x1ze"),
      session,
    });

    expect(cancelled.results).toEqual([
      expect.objectContaining({ callId: "call-stop", output: { status: "cancelled" } }),
      {
        callId: "call-wait",
        kind: "tool-result",
        output: {
          name: "remind",
          outcome: { status: "cancelled" },
          status: "settled",
          taskId: "remind-q4x1ze",
        },
        toolName: "task_wait",
      },
    ]);
    expect(getTaskTable(cancelled.session).records[0]?.wait).toBeUndefined();
  });

  it("keeps a cancelled agent available for new work", () => {
    const agent = createTaskRecord({
      child: LOCAL_CHILD,
      id: "research-7k2m9q",
      mode: "detached",
      resumable: true,
    });

    const cancelled = getTaskTable(cancel([agent], "research-7k2m9q").session);
    // Idle once the agent confirms the stop.
    expect(renderTasksNote(cancelled.records)).toBeUndefined();
    const { table } = applyTaskMessage(
      cancelled,
      {
        generation: 1,
        kind: "task.settled",
        outcome: { status: "cancelled" },
        taskId: "research-7k2m9q",
      },
      NOW,
    );

    expect(renderTasksNote(table.records)).toContain('<task id="research-7k2m9q" tool="research">');
    const continued = sendTask(table, {
      callId: "call-2",
      input: { message: "Try again." },
      mode: "attached",
      now: NOW,
      taskId: "research-7k2m9q",
      turnId: "turn-2",
    });
    expect(continued).toMatchObject({
      kind: "sent",
      record: { generation: 2, id: "research-7k2m9q", status: "working" },
      started: true,
    });
  });
});

describe("cancelTasksStep with the all selector", () => {
  it("cancels every working task, whichever turn started it, and leaves idle agents available", async () => {
    const waited = createTaskRecord({
      child: LOCAL_CHILD,
      id: "research-7k2m9q",
      turnId: "turn-1",
    });
    const nested = createTaskRecord({
      callId: "call-nested",
      id: "research-b81d0c",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });
    const idle = createTaskRecord({
      callId: "call-idle",
      child: { ...LOCAL_CHILD, sessionId: "idle-child" },
      delivered: true,
      id: "research-3fq8wd",
      mode: "detached",
      status: "completed",
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: ownerState([REMINDER, waited, nested, idle]),
    });

    expect(settledIds(events)).toEqual(["remind-q4x1ze", "research-7k2m9q", "research-b81d0c"]);
    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "control-hook", runId: "run-remind" },
      expect.any(String),
    );
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(records(sessionState).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "remind-q4x1ze", status: "cancelled" },
      { id: "research-7k2m9q", status: "cancelled" },
      { id: "research-b81d0c", status: "cancelled" },
      { id: "research-3fq8wd", status: "completed" },
    ]);
  });
});

describe("cancelTasksStep discards the results of a turn that ended early", () => {
  const BOB = { ...ALICE, principalId: "U-bob" };
  const DONE = { output: "Stand-up at 10.", status: "completed" } as const;

  /** A detached reminder whose result settled before its turn read it. */
  function settledReminder(id: string, auth: typeof ALICE | null, turnId = "turn-0") {
    return createTaskRecord({
      callId: `call-${id}`,
      creator: encodeTaskCreator({ auth }),
      id,
      kind: "workflow",
      mode: "detached",
      name: "remind",
      status: "completed",
      turnId,
    });
  }

  function withHeldResults(existing: readonly TaskRecord[]): DurableSessionState {
    const state = ownerState(existing);
    let session = state.snapshot.session;
    for (const record of existing.filter(({ status }) => status === "completed")) {
      session = holdTaskResult(session, record, DONE);
    }
    return { ...state, snapshot: { session } };
  }

  function pendingIds(state: DurableSessionState): string[] {
    return readPendingTaskResults(state.snapshot.session.state).map(({ taskId }) => taskId);
  }

  it("drops every held result on a cancelled turn, with nothing left to cancel", async () => {
    const update = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: withHeldResults([settledReminder("remind-a1", ALICE)]),
    });

    expect(pendingIds(update.sessionState)).toEqual([]);
    // Marked delivered, so the record is pruned and never blocks handoff.
    expect(records(update.sessionState)).toEqual([]);
    expect(update.events).toEqual([]);
  });

  it("drops only the failed turn's principal's results and cancels its working tasks", async () => {
    const working = { ...REMINDER, creator: encodeTaskCreator({ auth: ALICE }) };
    const update = await cancelTasksStep({
      selector: { kind: "held", principal: ALICE },
      serializedContext: {},
      sessionState: withHeldResults([
        working,
        settledReminder("remind-a1", ALICE),
        settledReminder("remind-b1", BOB),
      ]),
    });

    expect(pendingIds(update.sessionState)).toEqual(["remind-b1"]);
    expect(records(update.sessionState).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "remind-q4x1ze", status: "cancelled" },
      { id: "remind-b1", status: "completed" },
    ]);
  });

  it("drops only the results of tasks the named turn started", async () => {
    const update = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-0" },
      serializedContext: {},
      sessionState: withHeldResults([
        settledReminder("remind-a1", ALICE, "turn-0"),
        settledReminder("remind-a2", ALICE, "turn-1"),
      ]),
    });

    expect(pendingIds(update.sessionState)).toEqual(["remind-a2"]);
  });

  it("keeps held results for a workflow run's own cancel", async () => {
    const sessionState = withHeldResults([settledReminder("remind-a1", ALICE)]);

    const update = await cancelTasksStep({
      selector: { kind: "workflow-run", runId: "run-other" },
      serializedContext: {},
      sessionState,
    });

    expect(update.sessionState).toBe(sessionState);
  });
});

describe("cancelTasksStep with the turn selector", () => {
  it("cancels the working tasks one turn started and leaves other turns' tasks working", async () => {
    const other = createTaskRecord({ child: LOCAL_CHILD, id: "research-7k2m9q", turnId: "turn-1" });
    const nested = createTaskRecord({
      callId: "call-nested",
      id: "research-b81d0c",
      turnId: "turn-0",
      workflowCaller: { replyTo: "reply-hook", runId: "run-remind" },
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-0" },
      serializedContext: {},
      sessionState: ownerState([REMINDER, other, nested]),
    });

    expect(settledIds(events)).toEqual(["remind-q4x1ze", "research-b81d0c"]);
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(records(sessionState).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "remind-q4x1ze", status: "cancelled" },
      { id: "research-7k2m9q", status: "working" },
      { id: "research-b81d0c", status: "cancelled" },
    ]);
  });

  it("gives a task_wait on the cancelled task the cancellation as its result", async () => {
    const waited = { ...REMINDER, wait: { callId: "call-wait", startedAt: NOW } };
    const base = createTestSessionState({ sessionId: "parent" });
    const sessionState = {
      ...base,
      snapshot: {
        session: {
          ...base.snapshot.session,
          state: withBatch(taskTableState([waited]), ["call-wait"]).state,
        },
      },
    };

    const update = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-0" },
      serializedContext: {},
      sessionState,
    });

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-wait",
        output: expect.objectContaining({ outcome: { status: "cancelled" }, status: "settled" }),
      }),
    ]);
    expect(records(update.sessionState)[0]?.wait).toBeUndefined();
  });

  it("changes nothing for a turn that started no working task", async () => {
    const sessionState = ownerState([REMINDER]);

    const update = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-9" },
      serializedContext: {},
      sessionState,
    });

    expect(update.events).toEqual([]);
    expect(update.sessionState).toBe(sessionState);
  });

  it("leaves the running turn's task_wait live when the cancel names another turn", async () => {
    // Alice's current turn waits on a reminder her earlier turn started; a cancel for turn-9 misses it.
    const waited = { ...REMINDER, wait: { callId: "call-wait", startedAt: NOW } };
    const sessionState = batchState([waited], ["call-wait"]);

    const update = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-9" },
      serializedContext: {},
      sessionState,
    });

    expect(update.results).toEqual([]);
    expect(records(update.sessionState)[0]?.wait).toEqual({ callId: "call-wait", startedAt: NOW });
  });

  it("stops the agent calls a cancelled workflow run awaits, whichever turn started them", async () => {
    // The reminder's run asked a researcher for help during a later turn.
    const runAgent = createTaskRecord({
      callId: "call-nested",
      child: LOCAL_CHILD,
      id: "research-b81d0c",
      turnId: "turn-1",
      workflowCaller: { replyTo: "reply-hook", runId: RUN.runId },
    });

    const { events, sessionState } = await cancelTasksStep({
      selector: { kind: "turn", turnId: "turn-0" },
      serializedContext: {},
      sessionState: ownerState([REMINDER, runAgent]),
    });

    expect(settledIds(events)).toEqual(["remind-q4x1ze", "research-b81d0c"]);
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(records(sessionState).map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
  });
});

describe("cancelTasksStep with a live task_wait", () => {
  it("gives the wait the cancellation when every task is cancelled", async () => {
    const waited = { ...REMINDER, wait: { callId: "call-wait", startedAt: NOW } };

    const update = await cancelTasksStep({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState: batchState([waited], ["call-wait"]),
    });

    expect(update.results).toEqual([
      expect.objectContaining({
        callId: "call-wait",
        output: expect.objectContaining({ outcome: { status: "cancelled" }, status: "settled" }),
      }),
    ]);
    expect(records(update.sessionState)[0]?.wait).toBeUndefined();
  });
});

describe("cancelling a workflow task", () => {
  it("also stops the agent calls its run awaits", () => {
    const runAgent = createTaskRecord({
      callId: "call-nested",
      child: LOCAL_CHILD,
      id: "research-b81d0c",
      workflowCaller: { replyTo: "reply-hook", runId: RUN.runId },
    });
    const otherRunAgent = createTaskRecord({
      callId: "call-other",
      child: { ...LOCAL_CHILD, sessionId: "other-child" },
      id: "research-3fq8wd",
      workflowCaller: { replyTo: "other-hook", runId: "run-other" },
    });

    const { events, session } = cancel([REMINDER, runAgent, otherRunAgent], "remind-q4x1ze");

    expect(settledIds(events)).toEqual(["remind-q4x1ze", "research-b81d0c"]);
    expect(getTaskTable(session).records.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "remind-q4x1ze", status: "cancelled" },
      { id: "research-b81d0c", status: "cancelled" },
      { id: "research-3fq8wd", status: "working" },
    ]);
  });
});

describe("interruptAttachedCalls", () => {
  const SLEEP = createTaskRecord({
    callId: "call-sleep",
    child: { commandToken: "sleep-control", kind: "workflow", runId: "run-sleep" },
    id: "sleep-g7h8j9",
    kind: "workflow",
    name: "sleep",
    startedAt: "2026-09-24T13:59:48.000Z",
    turnId: "turn-1",
  });

  it("cancels an attached call through the cancel path with the interruption text", () => {
    const stopped = interruptAttachedCalls({
      callIds: [SLEEP.callId],
      now: NOW,
      session: { sessionId: "owner", state: taskTableState([SLEEP]) },
      turnId: "turn-1",
    });

    expect(stopped.results).toEqual([
      {
        callId: SLEEP.callId,
        kind: "tool-result",
        modelOutput: "Stopped after 12 s because a new message arrived.",
        output: { status: "interrupted", waitedMs: 12_000 },
        toolName: "sleep",
      },
    ]);
    expect(getTaskTable(stopped.session).records).toEqual([
      expect.objectContaining({
        cancelConfirmBy: expect.any(String),
        delivered: true,
        mode: "attached",
        status: "cancelled",
      }),
    ]);
    expect(stopped.events).toEqual([
      {
        data: { callId: SLEEP.callId, generation: 1, status: "cancelled", taskId: SLEEP.id },
        type: "task.settled",
      },
      { data: { taskId: SLEEP.id }, type: "task.ended" },
    ]);
    expect(stopped.commands).toEqual([
      expect.objectContaining({ commands: [{ kind: "cancel" }], kind: "send" }),
    ]);
  });

  it("leaves detached tasks, other turns' calls, settled calls, and ctx.agent calls alone", () => {
    const session = {
      sessionId: "owner",
      state: taskTableState([
        { ...REMINDER, callId: "call-a", turnId: "turn-1" },
        { ...SLEEP, callId: "call-b", id: "sleep-b", turnId: "turn-0" },
        { ...SLEEP, callId: "call-c", id: "sleep-c", status: "completed" as const },
        createTaskRecord({
          callId: "call-d",
          turnId: "turn-1",
          workflowCaller: { replyTo: "reply-hook", runId: "run-1" },
        }),
      ]),
    };

    const stopped = interruptAttachedCalls({
      callIds: ["call-a", "call-b", "call-c", "call-d"],
      now: NOW,
      session,
      turnId: "turn-1",
    });

    expect(stopped).toEqual({ commands: [], events: [], results: [], session });
  });
});

describe("interruptAttachedCallsStep", () => {
  it("ends a task_wait and cancels an attached run in one step, naming results after their calls", async () => {
    const deploy = createTaskRecord({
      callId: "call-deploy",
      child: { commandToken: "deploy-control", kind: "workflow", runId: "run-deploy" },
      id: "deploy-k1m2n3",
      kind: "workflow",
      name: "deploy",
      startedAt: NOW,
      turnId: "turn-1",
    });
    const waited = { ...REMINDER, wait: { callId: "call-wait", startedAt: NOW } };
    const state = withBatch(taskTableState([waited, deploy]), ["call-wait"]);
    const tasks = [
      ...(getPendingCoordinationBatch(state.state)?.tasks ?? []),
      {
        callId: "call-deploy",
        input: {},
        kind: "workflow-task",
        toolName: "ship_it",
        workflowId: "workflow//./agent/tools/deploy//execute",
      },
    ];
    const base = createTestSessionState({
      emissionState: { sequence: 1, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
      sessionId: "parent",
    });
    const sessionState = {
      ...base,
      snapshot: {
        session: {
          ...base.snapshot.session,
          state: {
            ...state.state,
            "eve.runtime.pendingCoordinationBatch": {
              ...(state.state?.["eve.runtime.pendingCoordinationBatch"] as object),
              tasks,
            },
          },
        },
      },
    };

    const update = await interruptAttachedCallsStep({
      callIds: ["call-wait", "call-deploy"],
      serializedContext: {},
      sessionState,
    });

    expect(
      update.results.map(({ callId, output, toolName }) => ({ callId, output, toolName })),
    ).toEqual([
      {
        callId: "call-wait",
        output: { status: "interrupted", taskId: REMINDER.id },
        toolName: "task_wait",
      },
      {
        callId: "call-deploy",
        output: { status: "interrupted", waitedMs: expect.any(Number) },
        toolName: "ship_it",
      },
    ]);
    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "deploy-control", runId: "run-deploy" },
      expect.any(String),
    );
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ id: REMINDER.id, status: "working" }),
      expect.objectContaining({ id: deploy.id, status: "cancelled" }),
    ]);
    expect(records(update.sessionState)[0]?.wait).toBeUndefined();
  });

  it("changes nothing when every selected call already settled", async () => {
    const sessionState = ownerState([{ ...REMINDER, mode: "attached", status: "completed" }]);
    const update = await interruptAttachedCallsStep({
      callIds: [REMINDER.callId],
      serializedContext: {},
      sessionState,
    });
    expect(update).toMatchObject({ events: [], results: [], sessionState });
  });
});

function call(taskId: string): RuntimeWorkflowTaskRequest {
  return {
    callId: "call-stop",
    input: { taskId },
    kind: "workflow-task",
    toolName: "task_cancel",
    workflowId: TASK_CANCEL_WORKFLOW_ID,
  };
}

function settledIds(events: readonly UnstampedMessageStreamEvent[]) {
  return events.flatMap((event) => (event.type === "task.settled" ? [event.data.taskId] : []));
}

function cancel(existing: readonly TaskRecord[], taskId: string) {
  return applyTaskCancelCall({
    caller: null,
    now: NOW,
    request: call(taskId),
    session: { sessionId: "owner", state: taskTableState(existing) },
  });
}

/** A session whose turn waits on these calls: `task_wait` calls, unless named `call-stop`. */
function withBatch(state: SessionStateMap, callIds: readonly string[]) {
  return setPendingCoordinationBatch({
    event: { sequence: 1, stepIndex: 1, turnId: "turn-1" },
    responseMessages: [],
    session: { history: [], state } as never,
    tasks: callIds.map((callId) =>
      callId === "call-stop"
        ? call("remind-q4x1ze")
        : {
            callId,
            input: { taskId: "remind-q4x1ze" },
            kind: "workflow-task",
            toolName: "task_wait",
            workflowId: TASK_WAIT_WORKFLOW_ID,
          },
    ),
  });
}

/** An owner whose turn waits on the given `task_wait` calls. */
function batchState(existing: readonly TaskRecord[], callIds: readonly string[]) {
  const base = createTestSessionState({ sessionId: "parent" });
  return {
    ...base,
    snapshot: {
      session: {
        ...base.snapshot.session,
        state: withBatch(taskTableState(existing), callIds).state,
      },
    },
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
