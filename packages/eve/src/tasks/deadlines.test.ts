import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import { applyTaskDeadlines } from "#tasks/deadlines.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import {
  getTaskTable,
  readTaskTimer,
  TASK_TIMER_STATE_KEY,
  taskTimerWakeToArm,
} from "#tasks/state.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestWorkflowTurnCancellation: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getWorld: vi.fn(),
}));

const STARTED = "2026-09-24T12:00:00.000Z";
const DEADLINE = "2026-09-24T14:00:00.000Z";
const AFTER_DEADLINE = "2026-09-24T14:00:05.000Z";
const LOCAL_CHILD = {
  continuationToken: "child-token",
  kind: "local" as const,
  sessionId: "child-session",
};
const WORKFLOW_CHILD = { commandToken: "command-1", kind: "workflow" as const, runId: "run-1" };
const REMOTE_CHILD = {
  callbackBaseUrl: "https://parent.example",
  kind: "remote" as const,
  sessionId: "remote-child",
  url: "https://billing.example",
};
const WORLD = { name: "world" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(deserializeContext).mockResolvedValue(new ContextContainer());
  vi.mocked(getWorld).mockResolvedValue(WORLD as never);
});

describe("applyTaskDeadlines", () => {
  it("times out a waited agent call: tool result, task.settled, and a cancel to the child", async () => {
    const working = createTaskRecord({
      child: LOCAL_CHILD,
      deadlineAt: DEADLINE,
      startedAt: STARTED,
    });

    const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

    const error = {
      code: "TIMED_OUT",
      message: "The agent did not finish within its time limit and was stopped.",
    };
    expect(update.results).toEqual([
      { callId: "call-1", isError: true, kind: "tool-result", output: error, toolName: "research" },
    ]);
    expect(update.replies).toEqual([]);
    expect(update.events).toEqual([
      {
        data: { callId: "call-1", error, status: "failed", taskId: working.id },
        type: "task.settled",
      },
    ]);
    expect(requestWorkflowTurnCancellation).toHaveBeenCalledExactlyOnceWith({
      sessionId: "child-session",
    });
    expect(records(update.sessionState)).toEqual([
      expect.objectContaining({
        cancelConfirmBy: "2026-09-24T14:00:35.000Z",
        child: LOCAL_CHILD,
        delivered: true,
        status: "failed",
      }),
    ]);
    // The confirmation window is the next wake.
    expect(taskTimerWakeToArm(stateOf(update.sessionState))).toBe("2026-09-24T14:00:35.000Z");
  });

  it("replies to a ctx.agent caller instead of returning a tool result", async () => {
    const working = createTaskRecord({
      child: REMOTE_CHILD,
      deadlineAt: DEADLINE,
      workflowCaller: { replyTo: "reply-hook", runId: "tool-run" },
    });

    const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

    expect(update.results).toEqual([]);
    expect(update.replies).toEqual([
      {
        replyTo: "reply-hook",
        result: {
          callId: "call-1",
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: {
            code: "TIMED_OUT",
            message: "The agent did not finish within its time limit and was stopped.",
          },
          subagentName: "research",
        },
      },
    ]);
    expect(update.events).toHaveLength(1);
  });

  it("hard-stops local and workflow children that never confirmed a cancel, but not remote ones", async () => {
    const confirmBy = "2026-09-24T14:00:30.000Z";
    const tasks = [
      createTaskRecord({ cancelConfirmBy: confirmBy, child: LOCAL_CHILD, status: "cancelled" }),
      createTaskRecord({
        callId: "call-2",
        cancelConfirmBy: confirmBy,
        child: WORKFLOW_CHILD,
        id: "deploy-abc234",
        kind: "workflow",
        name: "deploy",
        status: "cancelled",
      }),
      createTaskRecord({
        callId: "call-3",
        cancelConfirmBy: confirmBy,
        child: REMOTE_CHILD,
        id: "billing-abc234",
        name: "billing",
        status: "cancelled",
      }),
    ].map((record) => ({ ...record, delivered: true }));
    const proxied = {
      "local-request": { childContinuationToken: "child-token", kind: "question" },
      "workflow-request": {
        answerHook: { runId: "run-1" },
        childContinuationToken: "answer-hook",
        kind: "question",
      },
      other: { childContinuationToken: "other-token", kind: "question" },
    };

    const update = await applyTaskDeadlines(
      input(tasks, {
        now: "2026-09-24T14:00:31.000Z",
        state: { "eve.runtime.proxyInputRequests": proxied },
      }),
    );

    expect(vi.mocked(cancelRun).mock.calls).toEqual([
      [WORLD, "child-session", { cancelReason: expect.any(String) }],
      [WORLD, "run-1", { cancelReason: expect.any(String) }],
    ]);
    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    // A stopped local agent can take no more work; the remote agent stays available.
    expect(records(update.sessionState).map((record) => record.id)).toEqual(["billing-abc234"]);
    expect(records(update.sessionState)[0]).not.toHaveProperty("cancelConfirmBy");
    expect([...getProxyInputRequests(stateOf(update.sessionState)).keys()]).toEqual(["other"]);
  });

  it("settles a workflow task whose run already ended without reporting", async () => {
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("completed") } as never);
    const working = createTaskRecord({
      child: WORKFLOW_CHILD,
      deadlineAt: DEADLINE,
      id: "deploy-abc234",
      kind: "workflow",
      name: "deploy",
    });

    const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

    expect(getRun).toHaveBeenCalledExactlyOnceWith("run-1");
    const error = {
      code: "EXECUTION_FAILED",
      message: "The workflow run ended without reporting a result.",
    };
    expect(update.results).toEqual([
      { callId: "call-1", isError: true, kind: "tool-result", output: error, toolName: "deploy" },
    ]);
    expect(update.events).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ error, status: "failed" }) }),
    ]);
    expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
    // Nothing to confirm: the run already ended, so the settled record is pruned.
    expect(records(update.sessionState)).toEqual([]);
  });

  it("times out a workflow task whose run is still going and asks it to stop", async () => {
    vi.mocked(getRun).mockReturnValue({ status: Promise.resolve("running") } as never);
    const working = createTaskRecord({
      child: WORKFLOW_CHILD,
      deadlineAt: DEADLINE,
      id: "deploy-abc234",
      kind: "workflow",
      name: "deploy",
    });

    const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

    expect(update.results[0]?.output).toEqual({
      code: "TIMED_OUT",
      message: "The task did not finish within its time limit and was stopped.",
    });
    expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "command-1", runId: "run-1" },
      expect.any(String),
    );
  });

  it("clears the fired timer so the owner re-arms for the next deadline", async () => {
    const later = "2026-09-24T15:00:00.000Z";
    const tasks = [
      createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE }),
      createTaskRecord({ callId: "call-2", deadlineAt: later, id: "research-def567" }),
    ];

    const update = await applyTaskDeadlines(
      input(tasks, {
        now: AFTER_DEADLINE,
        state: { [TASK_TIMER_STATE_KEY]: { runId: "timer-1", wakeAt: DEADLINE } },
      }),
    );

    expect(readTaskTimer(stateOf(update.sessionState))).toBeUndefined();
    // The second task's deadline is still open; the first now awaits its confirmation.
    expect(taskTimerWakeToArm(stateOf(update.sessionState))).toBe("2026-09-24T14:00:35.000Z");
  });

  it("ignores a stale signal: nothing is due, and a later armed timer stays armed", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });
    const armed = { runId: "timer-2", wakeAt: DEADLINE };

    const update = await applyTaskDeadlines(
      input([working], {
        now: "2026-09-24T13:00:00.000Z",
        signal: { kind: "task.deadline", ownerRunId: "previous-owner", wakeAt: STARTED },
        state: { [TASK_TIMER_STATE_KEY]: armed },
      }),
    );

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    expect(records(update.sessionState)).toEqual([working]);
    expect(readTaskTimer(stateOf(update.sessionState))).toEqual(armed);
    expect(taskTimerWakeToArm(stateOf(update.sessionState))).toBeUndefined();
  });

  it("trusts the armed timer's wake time when this step's clock lags it", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });

    const update = await applyTaskDeadlines(
      input([working], {
        now: "2026-09-24T13:59:59.900Z",
        signal: { kind: "task.deadline", ownerRunId: "owner", wakeAt: DEADLINE },
        state: { [TASK_TIMER_STATE_KEY]: { runId: "timer-1", wakeAt: DEADLINE } },
      }),
    );

    expect(update.results).toHaveLength(1);
    expect(readTaskTimer(stateOf(update.sessionState))).toBeUndefined();
  });

  it("leaves a task waiting on a human alone", async () => {
    const waiting = createTaskRecord({
      child: LOCAL_CHILD,
      clockStoppedAt: STARTED,
      deadlineAt: DEADLINE,
      status: "input_required",
    });

    const update = await applyTaskDeadlines(input([waiting], { now: AFTER_DEADLINE }));

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(records(update.sessionState)).toEqual([waiting]);
  });

  it("removes an unreadable record without failing or reporting it", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });
    const state = taskTableState([working]);
    const table = state["eve.taskTable"] as { records: unknown[] };
    table.records.push({ id: "old-abc234", name: "old", v: 0 });
    expect(taskTimerWakeToArm(state)).toBe(new Date(0).toISOString());

    const update = await applyTaskDeadlines({
      now: "2026-09-24T13:00:00.000Z",
      serializedContext: {},
      sessionState: ownerState(state),
      signal: { kind: "task.deadline", ownerRunId: "owner", wakeAt: new Date(0).toISOString() },
    });

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(stateOf(update.sessionState)?.["eve.taskTable"]).toEqual({ records: [working] });
    expect(taskTimerWakeToArm(stateOf(update.sessionState))).toBe(DEADLINE);
  });
});

function input(
  tasks: readonly TaskRecord[],
  options: {
    readonly now: string;
    readonly signal?: TaskDeadlineSignal;
    readonly state?: SessionStateMap;
  },
) {
  return {
    now: options.now,
    serializedContext: {},
    sessionState: ownerState({ ...taskTableState(tasks), ...options.state }),
    signal: options.signal ?? {
      kind: "task.deadline" as const,
      ownerRunId: "owner",
      wakeAt: DEADLINE,
    },
  };
}

function ownerState(state: SessionStateMap): DurableSessionState {
  return createDurableSessionState({
    session: {
      agent: { dynamicModel: true, system: "", tools: [] },
      compaction: { recentWindowSize: 5, threshold: 10_000 },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent",
      state,
    },
  });
}

function stateOf(state: DurableSessionState): SessionStateMap | undefined {
  return readDurableSession(state).state;
}

function records(state: DurableSessionState): readonly TaskRecord[] {
  return getTaskTable(readDurableSession(state)).records;
}
