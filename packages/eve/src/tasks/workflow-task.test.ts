import { describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import type {
  WorkflowToolRunOutcome,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import { cancelTask } from "#tasks/table.js";
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
  it("commits the task before its run starts, then adopts the run and announces it", async () => {
    const startRun = vi.fn(async (record: TaskRecord) => {
      expect(record).toMatchObject({
        callId: "call-1",
        delivered: false,
        kind: "workflow",
        mode: "foreground",
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
    expect(started.result).toBeUndefined();
    const [record] = getTaskTable(started.session).records;
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
          mode: "foreground",
          name: "deploy",
          taskId: record!.id,
          turnId: "turn-1",
        },
        type: "task.started",
      },
    ]);
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
    expect(replayed).toEqual({ events: [], session: first.session });
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
    const cancelled = cancelTask({ records: [WORKING] }, WORKING.id, NOW).table.records;

    const update = settleWorkflowTask(
      settle(ownerState(taskTableState(cancelled)), { reason: "stopped", status: "cancelled" }),
    );

    expect(update.results).toEqual([]);
    expect(update.events).toEqual([]);
    // Confirmed, the cancelled record is no longer kept.
    expect(records(update.sessionState)).toEqual([]);
  });

  it.each([
    ["another run", { runId: "run-2" }],
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

  it("withdraws only the finished run's unanswered requests", () => {
    const answerToken = "eve:workflow-tool-run-answer:run-1:0";
    let state: SessionStateMap | undefined = taskTableState([WORKING]);
    state = upsertProxyInputRequestState({
      entries: [
        [
          answerToken,
          { answerHook: { runId: "run-1" }, childContinuationToken: answerToken, kind: "question" },
        ],
      ],
      forChildContinuationToken: answerToken,
      state,
    });
    state = upsertProxyInputRequestState({
      entries: [["other-request", { childContinuationToken: "subagent:child", kind: "question" }]],
      forChildContinuationToken: "subagent:child",
      state,
    });

    const update = settleWorkflowTask(
      settle(ownerState(state), { output: "done", status: "completed" }),
    );

    expect([...getProxyInputRequests(update.sessionState.snapshot.session.state).keys()]).toEqual([
      "other-request",
    ]);
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
