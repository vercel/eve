import { beforeEach, describe, expect, it, vi } from "vitest";

import { FatalError } from "#compiled/@workflow/errors/index.js";
import type { SessionAuthContext, TurnCaller } from "#channel/types.js";
import { AuthKey } from "#context/keys.js";
import { replyToCaller } from "#execution/session/program.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { fireSessionCallbackStep } from "#subagents/remote/callback-step.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
  reportRefusedCallerReplyStep,
} from "#tasks/child.js";
import { cancelTasks } from "#tasks/owner-body.js";
import type { TaskRecord } from "#tasks/record.js";
import { encodeTaskCreator } from "#tasks/results.js";

vi.mock("#tasks/child.js", async (importOriginal) => ({
  ...(await importOriginal()),
  notifyCancelledTaskCallerStep: vi.fn(),
  notifyTurnCallerStep: vi.fn(),
  reportRefusedCallerReplyStep: vi.fn(),
}));
vi.mock("#tasks/owner-body.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelTasks: vi.fn(),
}));
vi.mock("#subagents/remote/callback-step.js", () => ({ fireSessionCallbackStep: vi.fn() }));

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "app",
  principalId: "alice",
  principalType: "user",
};
const CALLER: TurnCaller = {
  callId: "call-delegate",
  replyTo: { kind: "hook", token: "owner-inbox" },
  subagentName: "researcher",
};

function target(records: readonly TaskRecord[]) {
  const base = createTestSessionState({ sessionId: "child" });
  const cursor = {
    serializedContext: { [AuthKey.name]: ALICE },
    sessionState: {
      ...base,
      snapshot: { session: { ...base.snapshot.session, state: taskTableState(records) } },
    },
  };
  // Only a turn's reply reads the full cursor, through the mocked `cancelTasks`.
  return { caller: CALLER, cursor: cursor as SessionStateCursor, sessionId: "child" };
}

function task(overrides: Partial<TaskRecord>): TaskRecord {
  return createTaskRecord({
    creator: encodeTaskCreator({ auth: ALICE }),
    id: "lookup-abc234",
    kind: "workflow",
    mode: "detached",
    name: "lookup",
    ...overrides,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("replyToCaller", () => {
  it("settles the caller once the turn's tasks are finished", async () => {
    await replyToCaller({
      ...target([task({ delivered: true, status: "completed" })]),
      reply: { kind: "turn", settled: { output: "Done." } },
    });

    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "parked",
      sessionId: "child",
      settled: { output: "Done." },
    });
    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
    expect(cancelTasks).not.toHaveBeenCalled();
  });

  it("reports an early reply, cancels the turn's working tasks, then settles the caller", async () => {
    const early = target([task({})]);
    await replyToCaller({ ...early, reply: { kind: "turn", settled: { output: "Early." } } });

    expect(reportRefusedCallerReplyStep).toHaveBeenCalledExactlyOnceWith({
      callId: CALLER.callId,
      sessionId: "child",
      taskIds: ["lookup-abc234"],
    });
    expect(cancelTasks).toHaveBeenCalledExactlyOnceWith(early.cursor, {
      kind: "held",
      principal: ALICE,
    });
    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "parked",
      sessionId: "child",
      settled: { output: "Early." },
    });
    const reported = vi.mocked(reportRefusedCallerReplyStep).mock.invocationCallOrder[0]!;
    const cancelled = vi.mocked(cancelTasks).mock.invocationCallOrder[0]!;
    const replied = vi.mocked(notifyTurnCallerStep).mock.invocationCallOrder[0]!;
    expect(reported).toBeLessThan(cancelled);
    expect(cancelled).toBeLessThan(replied);
  });

  it("never leaves a caller waiting when the report fails the session", async () => {
    vi.mocked(reportRefusedCallerReplyStep).mockRejectedValueOnce(new FatalError("bug"));

    await expect(
      replyToCaller({ ...target([task({})]), reply: { kind: "cancelled" } }),
    ).rejects.toThrow("bug");
    // The session's failure path then replies with the terminal answer, unchecked.
    await replyToCaller({
      ...target([task({})]),
      reply: { kind: "terminal", settled: { isError: true, output: "failed" } },
    });

    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "terminal",
      sessionId: "child",
      settled: { isError: true, output: "failed" },
    });
    expect(cancelTasks).not.toHaveBeenCalled();
  });

  it("ignores attached calls, workflow-owned agents, and another principal's tasks", async () => {
    await replyToCaller({
      ...target([
        task({ id: "attached-abc234", mode: "attached" }),
        task({ id: "agent-abc234", workflowCaller: { replyTo: "hook", runId: "run-1" } }),
        task({
          creator: encodeTaskCreator({ auth: { ...ALICE, principalId: "bob" } }),
          id: "bob-abc234",
        }),
      ]),
      reply: { kind: "cancelled", usage: undefined },
    });

    expect(notifyCancelledTaskCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      sessionId: "child",
    });
    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
  });

  it("sends a task-mode run's result to its session callback, with or without a caller", async () => {
    const callback = {
      output: "Summary.",
      serializedContext: {},
      status: "completed" as const,
    };
    await replyToCaller({
      ...target([]),
      caller: undefined,
      reply: { callback, kind: "callback" },
    });

    expect(fireSessionCallbackStep).toHaveBeenCalledExactlyOnceWith(callback);
  });

  it("does nothing without a caller", async () => {
    await replyToCaller({
      ...target([task({})]),
      caller: undefined,
      reply: { kind: "cancelled" },
    });

    expect(reportRefusedCallerReplyStep).not.toHaveBeenCalled();
    expect(notifyCancelledTaskCallerStep).not.toHaveBeenCalled();
  });
});

describe("reportRefusedCallerReplyStep", () => {
  it("fails a test run with a FatalError, which the runtime does not retry", async () => {
    const actual = await vi.importActual<typeof import("#tasks/child.js")>("#tasks/child.js");

    const report = actual.reportRefusedCallerReplyStep({
      callId: "call-delegate",
      sessionId: "child",
      taskIds: ["lookup-abc234"],
    });
    await expect(report).rejects.toBeInstanceOf(FatalError);
    await expect(report).rejects.toThrow(
      "Replied to caller call-delegate of session child while tasks lookup-abc234 are working.",
    );
  });
});
