import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { deserializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import {
  requestWorkflowTurnCancellation,
  resolveHookOwnerRunId,
  resolveSessionOwnerRunId,
} from "#execution/workflow-runtime.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTaskRecord, taskTable, taskTableState } from "#internal/testing/task-records.js";
import { cancelRun, getRun, getWorld } from "#internal/workflow/runtime.js";
import { applyTaskDeadlines } from "#tasks/deadlines.js";
import { applyTaskReport } from "#tasks/owner.js";
import type { TaskDeadlineSignal } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";
import { STATE_LOST_MESSAGE } from "#tasks/render.js";
import { readPendingTaskResults } from "#tasks/results.js";
import {
  getTaskTable,
  planTaskTimer,
  readTaskTimer,
  TASK_CALLBACK_ALIAS_STATE_KEY,
  TASK_TIMER_STATE_KEY,
} from "#tasks/state.js";
import { applyTaskMessage } from "#tasks/table.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { recordNestedAgentInvocationTerminal } from "#tracing/agent-invocation-terminal.js";
import { readRemoteTaskReport } from "#tasks/transport.js";
import { reportOrdering, type ChildTaskReport } from "#tasks/protocol.js";

vi.mock("#context/serialize.js", () => ({ deserializeContext: vi.fn() }));
vi.mock("#execution/tools/workflow/cancel.js", () => ({ cancelWorkflowToolRun: vi.fn() }));
vi.mock("#execution/workflow-runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  requestWorkflowTurnCancellation: vi.fn(),
  resolveHookOwnerRunId: vi.fn(),
  resolveSessionOwnerRunId: vi.fn(),
}));
vi.mock("#tracing/agent-invocation-terminal.js", async (importOriginal) => ({
  ...(await importOriginal()),
  recordNestedAgentInvocationTerminal: vi.fn(
    (input: { readonly serializedContext: Record<string, unknown> }) => input.serializedContext,
  ),
}));
vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getWorld: vi.fn(),
}));
vi.mock("#tasks/transport.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readRemoteTaskReport: vi.fn(),
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
  vi.mocked(resolveSessionOwnerRunId).mockImplementation(async (sessionId) => sessionId);
  vi.mocked(resolveHookOwnerRunId).mockResolvedValue(undefined);
  vi.mocked(recordNestedAgentInvocationTerminal).mockImplementation(
    (input) => input.serializedContext,
  );
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
    expect(wakeToArm(stateOf(update.sessionState))).toBe("2026-09-24T14:00:35.000Z");
    // The generation's invocation span ends with the timeout.
    expect(recordNestedAgentInvocationTerminal).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        callId: "call-1",
        sessionId: "parent",
        terminal: expect.objectContaining({ error: expect.any(Error), outcome: "failed" }),
      }),
    );
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
    const update = await applyTaskDeadlines(input(tasks, { now: "2026-09-24T14:00:31.000Z" }));

    expect(vi.mocked(cancelRun).mock.calls).toEqual([
      [WORLD, "child-session", { cancelReason: expect.any(String) }],
      [WORLD, "run-1", { cancelReason: expect.any(String) }],
    ]);
    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    // A stopped local agent can take no more work; the remote agent stays available.
    expect(records(update.sessionState).map((record) => record.id)).toEqual(["billing-abc234"]);
    expect(records(update.sessionState)[0]).not.toHaveProperty("cancelConfirmBy");
    // Each unconfirmed agent generation's span ends as cancelled; workflow tasks have none.
    expect(
      vi
        .mocked(recordNestedAgentInvocationTerminal)
        .mock.calls.map(([call]) => [call.callId, call.terminal.outcome]),
    ).toEqual([
      ["call-1", "cancelled"],
      ["call-3", "cancelled"],
    ]);
  });

  it("hard-stops the run that owns the child now, not the run the owner first knew", async () => {
    // Bob's idle research agent handed off to a successor run on a new deployment,
    // and a retried start left the deploy task's first run holding its command hook.
    vi.mocked(resolveSessionOwnerRunId).mockResolvedValue("child-successor-run");
    vi.mocked(resolveHookOwnerRunId).mockResolvedValue("run-0");
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
    ].map((record) => ({ ...record, delivered: true }));

    await applyTaskDeadlines(input(tasks, { now: "2026-09-24T14:00:31.000Z" }));

    expect(resolveSessionOwnerRunId).toHaveBeenCalledExactlyOnceWith("child-session");
    expect(resolveHookOwnerRunId).toHaveBeenCalledExactlyOnceWith("command-1");
    expect(vi.mocked(cancelRun).mock.calls.map((call) => call[1])).toEqual([
      "child-successor-run",
      "run-0",
    ]);
  });

  describe("reconciling a workflow task at its deadline", () => {
    const working = createTaskRecord({
      child: WORKFLOW_CHILD,
      deadlineAt: DEADLINE,
      id: "deploy-abc234",
      kind: "workflow",
      name: "deploy",
    });
    const run = (status: string, returnValue?: unknown) =>
      ({ returnValue: Promise.resolve(returnValue), status: Promise.resolve(status) }) as never;

    it("times out a task whose run is still working, like an agent", async () => {
      vi.mocked(getRun).mockReturnValue(run("running"));

      const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

      // One read of the run decides; a working run is not read again.
      expect(getRun).toHaveBeenCalledExactlyOnceWith("run-1");
      expect(update.results[0]?.output).toEqual({
        code: "TIMED_OUT",
        message: "The task did not finish within its time limit and was stopped.",
      });
      expect(cancelWorkflowToolRun).toHaveBeenCalledExactlyOnceWith(
        { hookToken: "command-1", runId: "run-1" },
        expect.any(String),
      );
      // The run gets its full 30-second cleanup window plus a margin before a hard stop.
      expect(records(update.sessionState)[0]?.cancelConfirmBy).toBe("2026-09-24T14:00:40.000Z");
      expect(recordNestedAgentInvocationTerminal).not.toHaveBeenCalled();
    });

    it("settles the task with the outcome its finished run returned, instead of timing out", async () => {
      vi.mocked(getRun).mockReturnValue(
        run("completed", {
          from: {
            callId: "call-1",
            runId: "run-1",
            sequence: 0,
            stepIndex: 0,
            taskId: "deploy-abc234",
            toolName: "deploy",
            turnId: "turn-1",
          },
          result: { output: { deployed: true }, status: "completed" },
        }),
      );

      const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

      expect(update.results).toEqual([
        { callId: "call-1", kind: "tool-result", output: { deployed: true }, toolName: "deploy" },
      ]);
      expect(update.events).toEqual([
        {
          data: {
            callId: "call-1",
            output: { deployed: true },
            status: "completed",
            taskId: "deploy-abc234",
          },
          type: "task.settled",
        },
      ]);
      expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
      // Delivered to the waiting call, the finished workflow task is pruned.
      expect(records(update.sessionState)).toEqual([]);
    });

    it("fails the task with the error its run returned when the run's report never arrived", async () => {
      // The run could not deliver its failed outcome, so it completed with it instead.
      vi.mocked(getRun).mockReturnValue(
        run("completed", {
          from: {
            callId: "call-1",
            runId: "run-1",
            sequence: 0,
            stepIndex: 0,
            taskId: "deploy-abc234",
            toolName: "deploy",
            turnId: "turn-1",
          },
          result: { error: { code: "DEPLOY_REJECTED", message: "Rejected." }, status: "failed" },
        }),
      );

      const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

      expect(update.results[0]).toMatchObject({
        isError: true,
        output: { code: "DEPLOY_REJECTED", message: "Rejected." },
      });
      expect(update.events).toEqual([
        {
          data: {
            callId: "call-1",
            error: { code: "DEPLOY_REJECTED", message: "Rejected." },
            status: "failed",
            taskId: "deploy-abc234",
          },
          type: "task.settled",
        },
      ]);
      expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
    });

    it("fails the task when its run failed before it reported", async () => {
      vi.mocked(getRun).mockReturnValue(run("failed"));

      const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

      expect(update.results[0]).toMatchObject({
        isError: true,
        output: {
          code: "EXECUTION_FAILED",
          message: "The workflow tool run failed before it reported its result.",
        },
      });
      expect(cancelWorkflowToolRun).not.toHaveBeenCalled();
    });

    it("times out a task whose run returned nothing, such as a duplicate start", async () => {
      vi.mocked(getRun).mockReturnValue(run("completed", undefined));

      const update = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));

      expect(update.results[0]?.output).toMatchObject({ code: "TIMED_OUT" });
    });

    it("reads nothing for a workflow task that is not due", async () => {
      await applyTaskDeadlines(input([working], { now: STARTED }));

      expect(getRun).not.toHaveBeenCalled();
    });
  });

  describe("a local child's result racing its deadline", () => {
    const working = createTaskRecord({
      child: LOCAL_CHILD,
      deadlineAt: DEADLINE,
      startedAt: STARTED,
    });
    const result: ChildTaskReport = {
      callId: "call-1",
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "parked",
        result: { kind: "succeeded", output: "Found three sources." },
        usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 2, outputTokens: 2 },
      },
      output: "Found three sources.",
      subagentName: "research",
    };
    const applyResult = async (sessionState: DurableSessionState) =>
      await applyTaskReport({
        now: AFTER_DEADLINE,
        payload: { kind: "runtime-action-result", results: [result] },
        serializedContext: {},
        sessionState,
      });
    const settledEvents = (...updates: { readonly events: readonly { type: string }[] }[]) =>
      updates.flatMap((update) => update.events.filter((event) => event.type === "task.settled"));

    it("keeps a result that arrived before the deadline signal, even past the deadline", async () => {
      const reported = await applyResult(input([working], { now: AFTER_DEADLINE }).sessionState);
      const deadline = await applyTaskDeadlines({
        ...input([], { now: AFTER_DEADLINE }),
        sessionState: reported.sessionState,
      });

      expect(reported.results).toEqual([
        expect.objectContaining({ callId: "call-1", output: "Found three sources." }),
      ]);
      expect(settledEvents(reported, deadline)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ status: "completed" }) }),
      ]);
      expect(deadline).toMatchObject({ events: [], replies: [], results: [] });
      expect(requestWorkflowTurnCancellation).not.toHaveBeenCalled();
    });

    it("drops a result that arrived after the deadline timed the task out", async () => {
      const deadline = await applyTaskDeadlines(input([working], { now: AFTER_DEADLINE }));
      const reported = await applyResult(deadline.sessionState);

      expect(settledEvents(deadline, reported)).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            error: expect.objectContaining({ code: "TIMED_OUT" }),
            status: "failed",
          }),
        }),
      ]);
      // The late result only confirms the child stopped.
      expect(reported).toMatchObject({ events: [], replies: [], results: [] });
      expect(records(reported.sessionState)).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]);
      expect(records(reported.sessionState)[0]).not.toHaveProperty("cancelConfirmBy");
    });
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
        state: {
          [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner", runId: "timer-1", wakeAt: DEADLINE },
        },
      }),
    );

    expect(readTaskTimer(stateOf(update.sessionState))).toBeUndefined();
    // The second task's deadline is still open; the first now awaits its confirmation.
    expect(wakeToArm(stateOf(update.sessionState))).toBe("2026-09-24T14:00:35.000Z");
  });

  it("ignores a stale signal: nothing is due, and a later armed timer stays armed", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });
    const armed = { ownerRunId: "owner", runId: "timer-2", wakeAt: DEADLINE };

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
    expect(wakeToArm(stateOf(update.sessionState))).toBeUndefined();
  });

  it("trusts the armed timer's wake time when this step's clock lags it", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });

    const update = await applyTaskDeadlines(
      input([working], {
        now: "2026-09-24T13:59:59.900Z",
        signal: { kind: "task.deadline", ownerRunId: "owner", wakeAt: DEADLINE },
        state: {
          [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner", runId: "timer-1", wakeAt: DEADLINE },
        },
      }),
    );

    expect(update.results).toHaveLength(1);
    expect(readTaskTimer(stateOf(update.sessionState))).toBeUndefined();
  });

  it("does not trust the wake time of a signal from a timer another owner run armed", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });

    const update = await applyTaskDeadlines(
      input([working], {
        now: "2026-09-24T13:59:59.900Z",
        signal: { kind: "task.deadline", ownerRunId: "previous-owner", wakeAt: DEADLINE },
        state: {
          [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner", runId: "timer-1", wakeAt: DEADLINE },
        },
      }),
    );

    expect(update.results).toEqual([]);
    expect(readTaskTimer(stateOf(update.sessionState))?.runId).toBe("timer-1");
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

  it("reports an unreadable background record as a held STATE_LOST result and removes it", async () => {
    const working = createTaskRecord({ child: LOCAL_CHILD, deadlineAt: DEADLINE });
    const creator = { auth: null };
    const update = await applyLost(working, {
      callId: "call-9",
      creator,
      generation: 2,
      id: "old-abc234",
      kind: "workflow",
      mode: "background",
      name: "old",
      v: 0,
    });

    expect(update).toMatchObject({
      events: [
        {
          data: {
            callId: "call-9",
            error: { code: "STATE_LOST", message: STATE_LOST_MESSAGE },
            status: "failed",
            taskId: "old-abc234",
          },
          type: "task.settled",
        },
      ],
      replies: [],
      results: [],
    });
    expect(readPendingTaskResults(stateOf(update.sessionState))).toEqual([
      {
        creator,
        generation: 2,
        kind: "workflow",
        name: "old",
        outcome: { error: { code: "STATE_LOST", message: STATE_LOST_MESSAGE }, status: "failed" },
        taskId: "old-abc234",
      },
    ]);
    expect(stateOf(update.sessionState)?.["eve.taskTable"]).toEqual({ records: [working] });
    expect(wakeToArm(stateOf(update.sessionState))).toBe(DEADLINE);
  });

  it("resolves a waited call or a ctx.agent caller whose record is unreadable", async () => {
    const error = { code: "STATE_LOST", message: STATE_LOST_MESSAGE };
    const waited = await applyLost(undefined, {
      callId: "call-9",
      id: "old-abc234",
      mode: "foreground",
      name: "old",
      v: 0,
    });
    expect(waited.results).toEqual([
      { callId: "call-9", isError: true, kind: "tool-result", output: error, toolName: "old" },
    ]);

    const nested = await applyLost(undefined, {
      callId: "call-9",
      id: "old-abc234",
      mode: "foreground",
      name: "old",
      v: 0,
      workflowCaller: { replyTo: "reply-hook", runId: "run-1" },
    });
    expect(nested.results).toEqual([]);
    expect(nested.replies).toEqual([
      {
        replyTo: "reply-hook",
        result: {
          callId: "call-9",
          isError: true,
          kind: "subagent-result",
          origin: "dispatch",
          output: error,
          subagentName: "old",
        },
      },
    ]);
    for (const update of [waited, nested]) {
      expect(readPendingTaskResults(stateOf(update.sessionState))).toEqual([]);
      expect(stateOf(update.sessionState)?.["eve.taskTable"]).toBeUndefined();
    }
  });

  describe("reconciling a remote task at its deadline", () => {
    const ALIAS = "eve:task-callback:owner-alias";
    const withAlias = { [TASK_CALLBACK_ALIAS_STATE_KEY]: ALIAS };
    const remote = createTaskRecord({
      child: REMOTE_CHILD,
      deadlineAt: DEADLINE,
      name: "billing",
      startedAt: STARTED,
    });
    const report = (answer: number | undefined, steers?: number): ChildTaskReport => ({
      ...reportOrdering(steers, answer),
      callId: "call-1",
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "parked",
        result: { kind: "succeeded", output: "Refund approved." },
        usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 4, outputTokens: 3 },
      },
      output: "Refund approved.",
      subagentName: "billing",
    });

    it("settles the task with the answer whose callback never arrived, instead of timing out", async () => {
      vi.mocked(readRemoteTaskReport).mockResolvedValueOnce(report(2));

      const update = await applyTaskDeadlines(
        input([remote], { now: AFTER_DEADLINE, state: withAlias }),
      );

      // The child shows the report only to the holder of the owner's callback token.
      expect(readRemoteTaskReport).toHaveBeenCalledExactlyOnceWith(
        remote,
        expect.anything(),
        sessionInboxHookToken(ALIAS),
      );
      expect(update.results).toEqual([
        { callId: "call-1", kind: "tool-result", output: "Refund approved.", toolName: "billing" },
      ]);
      expect(update.events).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ output: "Refund approved.", status: "completed" }),
          type: "task.settled",
        }),
      ]);
      expect(records(update.sessionState)).toEqual([
        expect.objectContaining({
          answerSeq: 2,
          child: REMOTE_CHILD,
          delivered: true,
          status: "completed",
        }),
      ]);
    });

    it("times out a remote task whose child has not answered", async () => {
      vi.mocked(readRemoteTaskReport).mockResolvedValueOnce(undefined);

      const update = await applyTaskDeadlines(
        input([remote], { now: AFTER_DEADLINE, state: withAlias }),
      );

      expect(update.results).toEqual([
        expect.objectContaining({
          isError: true,
          output: expect.objectContaining({ code: "TIMED_OUT" }),
        }),
      ]);
      expect(records(update.sessionState)).toEqual([expect.objectContaining({ status: "failed" })]);
    });

    it("never settles the next generation of a call with the answer to the one before", async () => {
      // Two steering messages were sent; the agent answered after the first,
      // so the owner applied that answer and started the call's next
      // generation for the second message.
      const table = applyTaskMessage(
        taskTable([{ ...remote, mode: "background" as const, steers: 2 }]),
        {
          answer: 2,
          generation: 1,
          kind: "task.settled",
          outcome: { output: "Refund approved.", status: "completed" },
          steers: 1,
          taskId: remote.id,
        },
        STARTED,
      ).table;
      const next = table.records[0]!;
      expect(next).toMatchObject({ answerSeq: 2, generation: 2, status: "working", steers: 1 });
      // At the new generation's deadline the latest report is still that answer,
      // which accounts for as many steering messages as the generation waits on.
      vi.mocked(readRemoteTaskReport).mockResolvedValueOnce(report(2, 1));

      const update = await applyTaskDeadlines(
        input([next], { now: "2026-09-24T16:00:05.000Z", state: withAlias }),
      );

      expect(update.events).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            error: expect.objectContaining({ code: "TIMED_OUT" }),
            status: "failed",
          }),
          type: "task.settled",
        }),
      ]);
    });

    it("ignores a report that cannot say which answer it is", async () => {
      vi.mocked(readRemoteTaskReport).mockResolvedValueOnce(report(undefined));

      const update = await applyTaskDeadlines(
        input([remote], { now: AFTER_DEADLINE, state: withAlias }),
      );

      expect(records(update.sessionState)).toEqual([expect.objectContaining({ status: "failed" })]);
    });

    it("reads nothing for a remote task that is not due or waits on a human", async () => {
      await applyTaskDeadlines(
        input(
          [
            { ...remote, deadlineAt: "2026-09-24T15:00:00.000Z" },
            { ...remote, clockStoppedAt: STARTED, id: "billing-def567", status: "input_required" },
          ],
          { now: AFTER_DEADLINE, state: withAlias },
        ),
      );

      expect(readRemoteTaskReport).not.toHaveBeenCalled();
    });
  });

  it("reports a background run an earlier release left working as STATE_LOST and removes its registry", async () => {
    const auth = {
      attributes: {},
      authenticator: "slack",
      principalId: "U-alice",
      principalType: "user",
    };
    const origin = { stepIndex: 0, turnId: "turn-old" };
    const address = { hookToken: "inbox", runId: "run-old" };
    const legacyRun = (callId: string, task?: Record<string, unknown>) => ({
      address,
      callId,
      lifetime: task === undefined ? "turn" : "session",
      origin,
      task,
      toolName: "researcher",
    });
    const state = {
      "eve.workflowTool": {
        runs: [
          legacyRun("call-working", {
            dispatchContext: { auth: { current: auth, initiator: auth } },
            metadata: { kind: "subagent", name: "researcher" },
            taskId: "call-working",
          }),
          legacyRun("call-reported", {
            dispatchContext: { auth: { current: auth, initiator: auth } },
            metadata: { kind: "tool", name: "deploy" },
            outcome: { lastOutput: { type: "result", value: "ok" }, status: "completed" },
            taskId: "call-reported",
          }),
          legacyRun("call-waiting"),
        ],
        version: 3,
      },
    };
    // Its loss wakes the owner at once.
    expect(wakeToArm(state)).toBe(new Date(0).toISOString());

    const update = await applyTaskDeadlines({
      now: "2026-09-24T13:00:00.000Z",
      serializedContext: {},
      sessionState: ownerState(state),
      signal: { kind: "task.deadline", ownerRunId: "owner", wakeAt: new Date(0).toISOString() },
    });

    const error = { code: "STATE_LOST", message: STATE_LOST_MESSAGE };
    expect(update.events).toEqual([
      {
        data: { callId: "call-working", error, status: "failed", taskId: "call-working" },
        type: "task.settled",
      },
    ]);
    // Its creator's next result turn tells the model the work is lost.
    expect(readPendingTaskResults(stateOf(update.sessionState))).toEqual([
      {
        creator: { auth },
        generation: 1,
        kind: "agent",
        name: "researcher",
        outcome: { error, status: "failed" },
        taskId: "call-working",
      },
    ]);
    expect(stateOf(update.sessionState)?.["eve.workflowTool"]).toBeUndefined();
    expect(wakeToArm(stateOf(update.sessionState))).toBeUndefined();
  });

  it("removes an unreadable record whose result was already delivered without reporting it", async () => {
    const update = await applyLost(undefined, {
      delivered: true,
      id: "old-abc234",
      name: "old",
      v: 0,
    });

    expect(update).toMatchObject({ events: [], replies: [], results: [] });
    expect(readPendingTaskResults(stateOf(update.sessionState))).toEqual([]);
    expect(stateOf(update.sessionState)?.["eve.taskTable"]).toBeUndefined();
  });
});

/** Applies the immediate wake an unreadable record arms, with `unreadable` stored beside `working`. */
async function applyLost(working: TaskRecord | undefined, unreadable: Record<string, unknown>) {
  const state = taskTableState(working === undefined ? [] : [working]);
  (state["eve.taskTable"] as { records: unknown[] }).records.push(unreadable);
  expect(wakeToArm(state)).toBe(new Date(0).toISOString());
  return await applyTaskDeadlines({
    now: "2026-09-24T13:00:00.000Z",
    serializedContext: {},
    sessionState: ownerState(state),
    signal: { kind: "task.deadline", ownerRunId: "owner", wakeAt: new Date(0).toISOString() },
  });
}

/** The wake the owner would arm next, ignoring clock and owner-run checks. */
function wakeToArm(state: SessionStateMap | undefined): string | undefined {
  const plan = planTaskTimer(state, { nowMs: 0, ownerRunId: "owner" });
  return plan.kind === "arm" ? plan.wakeAt : undefined;
}

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
