import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { taskTable, createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { hasPendingTaskInput } from "#tasks/input.js";
import type { TaskRecord } from "#tasks/record.js";
import { readPendingTaskResults } from "#tasks/results.js";
import { getTaskTable } from "#tasks/state.js";
import { cancelTask } from "#tasks/table.js";
import { TASK_WAIT_WORKFLOW_ID } from "#tasks/wait-tool.js";
import { settleWorkflowTask, startWorkflowTask } from "#tasks/workflow-task.js";

vi.mock("#internal/logging.js", () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn() })),
  logError: vi.fn(),
}));

const NOW = "2026-09-24T14:00:00.000Z";
const REQUEST = {
  callId: "call-1",
  input: { service: "api" },
  kind: "workflow-task" as const,
  toolName: "deploy",
  workflowId: "workflow//./agent/tools/deploy//execute",
};
const PARENT: { readonly sessionId: string; readonly state?: SessionStateMap } = {
  sessionId: "parent",
};
const RUN = { commandToken: "control-hook", kind: "workflow" as const, runId: "run-1" };
const FROM = {
  callId: "call-1",
  input: { service: "api" },
  runId: "run-1",
  sequence: 3,
  stepIndex: 1,
  taskId: "deploy-abc234",
  toolName: "deploy",
  turnId: "turn-1",
};
const WORKING = createTaskRecord({
  callId: "call-1",
  child: RUN,
  id: "deploy-abc234",
  kind: "workflow",
  name: "deploy",
  turnId: "turn-1",
});

describe("startWorkflowTask", () => {
  it("commits the task before its run starts, then adopts the run, announces it, and returns its receipt", async () => {
    const startRun = vi.fn(async (record: TaskRecord) => {
      expect(record).toMatchObject({
        callId: "call-1",
        delivered: false,
        kind: "workflow",
        mode: "detached",
        name: "deploy",
        status: "working",
        turnId: "turn-1",
      });
      expect(record.child).toBeUndefined();
      return { hookToken: "control-hook", runId: "run-1" };
    });

    const started = await startWorkflowTask({
      now: NOW,
      request: REQUEST,
      session: PARENT,
      startRun,
      turnId: "turn-1",
    });

    expect(startRun).toHaveBeenCalledOnce();
    const [record] = getTaskTable(started.session).records;
    expect(started.result).toEqual({
      callId: "call-1",
      kind: "tool-result",
      modelOutput: `Started task ${record!.id}. Use task_wait for its result.`,
      output: { status: "working", taskId: record!.id },
      toolName: "deploy",
    });
    expect(record).toMatchObject({
      callId: "call-1",
      child: RUN,
      id: expect.stringMatching(/^deploy-[0-9a-z]{6}$/),
      kind: "workflow",
      status: "working",
    });
    // Workflow tool calls have no per-call time limit.
    expect(record?.deadlineAt).toBeUndefined();
    expect(record?.id).toBe(startRun.mock.calls[0]![0].id);
    expect(started.events).toEqual([
      {
        data: {
          callId: "call-1",
          kind: "workflow",
          mode: "detached",
          name: "deploy",
          taskId: record!.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
  });

  it("holds an attached tool's call for its run's outcome instead of returning a receipt", async () => {
    const started = await startWorkflowTask({
      now: NOW,
      request: { ...REQUEST, attached: true },
      session: PARENT,
      startRun: async () => ({ hookToken: "control-hook", runId: "run-1" }),
      turnId: "turn-1",
    });

    expect(started.result).toBeUndefined();
    expect(getTaskTable(started.session).records).toEqual([
      expect.objectContaining({ child: RUN, mode: "attached", status: "working" }),
    ]);
    expect(started.events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ mode: "attached" }) }),
    ]);
  });

  it("gives the task the tool's authored timeout as its deadline", async () => {
    const startRun = async () => ({ hookToken: "control-hook", runId: "run-1" });
    const deadline = async (timeout: number | false) =>
      getTaskTable(
        (
          await startWorkflowTask({
            now: NOW,
            request: { ...REQUEST, timeout },
            session: PARENT,
            startRun,
            turnId: "turn-1",
          })
        ).session,
      ).records[0]?.deadlineAt;

    await expect(deadline(60_000)).resolves.toBe(new Date(Date.parse(NOW) + 60_000).toISOString());
    await expect(deadline(false)).resolves.toBeUndefined();
  });

  it("starts no second run for a replayed call", async () => {
    const first = await startWorkflowTask({
      now: NOW,
      request: REQUEST,
      session: PARENT,
      startRun: async () => ({ hookToken: "control-hook", runId: "run-1" }),
      turnId: "turn-1",
    });
    const startRun = vi.fn();

    const replayed = await startWorkflowTask({
      now: NOW,
      request: REQUEST,
      session: first.session,
      startRun,
      turnId: "turn-1",
    });

    expect(startRun).not.toHaveBeenCalled();
    // A detached call still owes its receipt.
    expect(replayed).toEqual({ events: [], result: first.result, session: first.session });
  });

  it("settles a run that fails to start as START_FAILED and returns the error at once", async () => {
    const started = await startWorkflowTask({
      now: NOW,
      request: REQUEST,
      session: PARENT,
      startRun: async () => {
        throw new Error("Workflow queue unavailable");
      },
      turnId: "turn-1",
    });

    expect(started.result).toEqual({
      callId: "call-1",
      isError: true,
      kind: "tool-result",
      output: "Workflow queue unavailable",
      toolName: "deploy",
    });
    expect(started.events).toEqual([
      {
        data: {
          callId: "call-1",
          error: { code: "START_FAILED", message: "Workflow queue unavailable" },
          status: "failed",
          taskId: expect.stringMatching(/^deploy-/),
        },
        type: "task.settled",
      },
    ]);
    // Delivered with its error result, the settled record is not kept.
    expect(getTaskTable(started.session).records).toEqual([]);
  });

  it("ignores the workflow tool run registry earlier releases wrote", async () => {
    const stale = {
      "eve.workflowTool": {
        runs: [
          {
            address: { hookToken: "old-hook", runId: "old-run" },
            callId: "call-1",
            lifetime: "turn",
            origin: { stepIndex: 0, turnId: "turn-1" },
            toolName: "deploy",
          },
        ],
        version: 3,
      },
    };

    const started = await startWorkflowTask({
      now: NOW,
      request: REQUEST,
      session: { sessionId: "parent", state: stale },
      startRun: async () => ({ hookToken: "control-hook", runId: "run-1" }),
      turnId: "turn-1",
    });

    expect(getTaskTable(started.session).records).toEqual([
      expect.objectContaining({ child: RUN, status: "working" }),
    ]);
    expect(
      settleWorkflowTask(
        settle(
          ownerState(stale),
          { output: "done", status: "completed" },
          {
            runId: "old-run",
          },
        ),
      ).results,
    ).toEqual([]);
  });
});

describe("settleWorkflowTask for a background task", () => {
  const BACKGROUND = { ...WORKING, creator: { auth: null }, mode: "detached" as const };

  it("gives the result to a live task_wait on the task instead of holding it", () => {
    const waited = { ...BACKGROUND, wait: { callId: "call-wait", startedAt: NOW } };
    const state = setPendingCoordinationBatch({
      event: { sequence: 1, stepIndex: 1, turnId: "turn-2" },
      responseMessages: [],
      session: { history: [], state: taskTableState([waited]) } as never,
      tasks: [
        {
          callId: "call-wait",
          input: { taskId: BACKGROUND.id },
          kind: "workflow-task",
          toolName: "task_wait",
          workflowId: TASK_WAIT_WORKFLOW_ID,
        },
      ],
    }).state;

    const update = settleWorkflowTask(
      settle(ownerState(state), { output: { reminder: "Stand-up" }, status: "completed" }),
    );

    expect(update.results).toEqual([
      {
        callId: "call-wait",
        kind: "tool-result",
        output: {
          name: "deploy",
          outcome: { output: { reminder: "Stand-up" }, status: "completed" },
          status: "settled",
          taskId: BACKGROUND.id,
        },
        toolName: "task_wait",
      },
    ]);
    expect(readPendingTaskResults(update.sessionState.snapshot.session.state)).toEqual([]);
    // Delivered and finished, so the owner prunes the record.
    expect(records(update.sessionState)).toEqual([]);
  });

  it("holds the result for delivery instead of resolving a tool call", () => {
    const update = settleWorkflowTask(
      settle(ownerState(taskTableState([BACKGROUND])), {
        output: { reminder: "Stand-up" },
        status: "completed",
      }),
    );

    expect(update.results).toEqual([]);
    expect(update.events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
    ]);
    const state = update.sessionState.snapshot.session.state;
    expect(readPendingTaskResults(state)).toEqual([
      {
        creator: { auth: null },
        generation: 1,
        kind: "workflow",
        name: "deploy",
        outcome: { output: { reminder: "Stand-up" }, status: "completed" },
        taskId: BACKGROUND.id,
      },
    ]);
    // Undelivered, so the [Tasks] note keeps listing it until the result reaches history.
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({ delivered: false, status: "completed" }),
    ]);
  });

  it("never holds a result for a background task the owner cancelled", () => {
    const cancelled = cancelTask(taskTable([BACKGROUND]), BACKGROUND.id, NOW).table.records;

    const update = settleWorkflowTask(
      settle(ownerState(taskTableState(cancelled)), { output: "late", status: "completed" }),
    );

    expect(update).toMatchObject({ events: [], results: [] });
    expect(readPendingTaskResults(update.sessionState.snapshot.session.state)).toEqual([]);
  });
});

describe("settleWorkflowTask", () => {
  it("settles a completed run, returns its tool result, and reports the outcome", () => {
    const update = settleWorkflowTask(
      settle(ownerState(taskTableState([WORKING])), {
        output: { deployed: true },
        status: "completed",
      }),
    );

    expect(update.results).toEqual([
      { callId: "call-1", kind: "tool-result", output: { deployed: true }, toolName: "deploy" },
    ]);
    expect(update.events).toEqual([
      {
        data: {
          callId: "call-1",
          output: { deployed: true },
          status: "completed",
          taskId: WORKING.id,
        },
        type: "task.settled",
      },
    ]);
    // The result reached the waiting turn, so the settled record is not kept.
    expect(records(update.sessionState)).toEqual([]);
  });

  it.each([
    [
      "a coded error",
      { code: "DEPLOY_REJECTED", message: "Alice's change needs review." },
      { code: "DEPLOY_REJECTED", message: "Alice's change needs review." },
    ],
    [
      "an error message",
      { message: "Deployment timed out.", name: "Error" },
      { code: "EXECUTION_FAILED", message: "Deployment timed out." },
    ],
  ])("reports a failed run with %s as the task error", (_label, error, expected) => {
    const update = settleWorkflowTask(
      settle(ownerState(taskTableState([WORKING])), { error, status: "failed" }),
    );

    expect(update.results).toEqual([expect.objectContaining({ callId: "call-1", isError: true })]);
    expect(update.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ error: expected, status: "failed" }),
      }),
    ]);
  });

  it("reports a run that cancelled itself as a cancelled call", () => {
    const update = settleWorkflowTask(
      settle(ownerState(taskTableState([WORKING])), {
        reason: "The deployment window closed.",
        status: "cancelled",
      }),
    );

    expect(update.results).toEqual([
      {
        callId: "call-1",
        isError: true,
        kind: "tool-result",
        output: "The deployment window closed.",
        toolName: "deploy",
      },
    ]);
    expect(update.events).toEqual([
      {
        data: { callId: "call-1", status: "cancelled", taskId: WORKING.id },
        type: "task.settled",
      },
    ]);
  });

  it("treats the outcome of a call the owner cancelled as confirmation only", () => {
    const cancelled = cancelTask(taskTable([WORKING]), WORKING.id, NOW).table.records;

    const update = settleWorkflowTask(
      settle(ownerState(taskTableState(cancelled)), { reason: "stopped", status: "cancelled" }),
    );

    expect(update.results).toEqual([]);
    expect(update.events).toEqual([]);
    // Confirmed, the cancelled record is no longer kept.
    expect(records(update.sessionState)).toEqual([]);
  });

  it("settles from the run that holds the task's hook, even when a retried start recorded another", () => {
    // The recorded run is a duplicate that exited; the first run claimed the hook and reports.
    const state = ownerState(taskTableState([{ ...WORKING, child: { ...RUN, runId: "run-dup" } }]));

    const update = settleWorkflowTask(settle(state, { output: "done", status: "completed" }));

    expect(update.results).toEqual([
      { callId: "call-1", kind: "tool-result", output: "done", toolName: "deploy" },
    ]);
  });

  it.each([
    ["another task", { taskId: "deploy-def567" }],
    ["another turn", { turnId: "turn-2" }],
    ["another call", { callId: "call-2" }],
    ["another tool", { toolName: "rollback" }],
  ])("drops an outcome from %s", (_label, from) => {
    const state = ownerState(taskTableState([WORKING]));

    const update = settleWorkflowTask(settle(state, { output: "done", status: "completed" }, from));

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(update.sessionState).toBe(state);
  });

  it("drops a duplicate outcome after the first settled the call", () => {
    const first = settleWorkflowTask(
      settle(ownerState(taskTableState([WORKING])), { output: "done", status: "completed" }),
    );

    const duplicate = settleWorkflowTask(
      settle(first.sessionState, { output: "done", status: "completed" }),
    );

    expect(duplicate).toMatchObject({ events: [], results: [] });
    expect(duplicate.sessionState).toBe(first.sessionState);
  });

  it("withdraws the finished run's pending question with its task", () => {
    const question = {
      action: { callId: "call-1", input: {}, kind: "tool-call" as const, toolName: "deploy" },
      kind: "question" as const,
      prompt: "Deploy now?",
      requestId: "ask-1",
    };
    const waiting: TaskRecord = {
      ...WORKING,
      input: [{ requests: [question], sequence: 0, stepIndex: 0, turnId: "turn-1" }],
      status: "input_required",
    };

    const update = settleWorkflowTask(
      settle(ownerState(taskTableState([waiting])), { output: "done", status: "completed" }),
    );

    expect(hasPendingTaskInput(update.sessionState.snapshot.session)).toBe(false);
  });
});

function ownerState(state: SessionStateMap | undefined): DurableSessionState {
  const base = createTestSessionState({ sessionId: "parent" });
  return { ...base, snapshot: { session: { ...base.snapshot.session, state } } };
}

function settle(
  sessionState: DurableSessionState,
  result: WorkflowToolRunOutcome,
  from: Partial<WorkflowToolRunOutcomeMessage["from"]> = {},
) {
  return {
    message: { from: { ...FROM, ...from }, result },
    now: NOW,
    serializedContext: {},
    sessionState,
  };
}

function records(state: DurableSessionState): readonly TaskRecord[] {
  return getTaskTable(state.snapshot.session).records;
}
