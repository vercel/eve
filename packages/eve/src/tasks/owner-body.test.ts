import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#tasks/emit-event-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import {
  applyTaskDeadline,
  applyTaskOwnerUpdate,
  cancelTasks,
  cancelTurnDescendants,
  closeTaskOwnerInbox,
  settleWorkflowTask,
  startAgentTasks,
  syncTaskTimer,
} from "#tasks/owner-body.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import type { SessionInboxPayload } from "#execution/session-inbox/inbox.js";
import { applyTaskReportStep, startAgentTasksStep } from "#tasks/owner.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY, TASK_TIMER_STATE_KEY } from "#tasks/state.js";
import { armTaskTimerStep, cancelTaskTimerStep } from "#tasks/timer-steps.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { settleWorkflowTaskStep } from "#tasks/workflow-task.js";

vi.mock("#tasks/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(),
}));
vi.mock("#tasks/deadlines.js", () => ({ applyTaskDeadlinesStep: vi.fn() }));
vi.mock("#tasks/timer-steps.js", () => ({
  armTaskTimerStep: vi.fn(),
  cancelTaskTimerStep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));
vi.mock("#tasks/owner.js", () => ({
  applyTaskReportStep: vi.fn(),
  startAgentTasksStep: vi.fn(),
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));
vi.mock("#tasks/cancel.js", () => ({ cancelTasksStep: vi.fn() }));
vi.mock("#tasks/workflow-task.js", () => ({ settleWorkflowTaskStep: vi.fn() }));

const ALIAS = `eve:task-callback:${"ab".repeat(24)}`;
const CALL = { callId: "call-1", input: { message: "Find sources.", target: "research" } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(startAgentTasksStep).mockImplementation(async (input) => ({
    events: [],
    replies: [],
    results: [],
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  }));
});

describe("startAgentTasks", () => {
  it("claims a callback alias the start step minted, then starts the calls again", async () => {
    const withAlias = stateWithAlias();
    vi.mocked(startAgentTasksStep)
      .mockResolvedValueOnce({
        callbackAliasMinted: true,
        events: [],
        replies: [],
        results: [],
        serializedContext: {},
        sessionState: withAlias,
      })
      .mockImplementationOnce(async (input) => ({
        events: [],
        replies: [],
        results: [],
        serializedContext: input.serializedContext,
        sessionState: input.sessionState,
      }));
    const claimSessionHooks = vi.fn(async () => {});
    const cursor = createCursor(createTestSessionState(), claimSessionHooks);

    await startAgentTasks(cursor, [CALL]);

    expect(startAgentTasksStep).toHaveBeenCalledTimes(2);
    expect(startAgentTasksStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ calls: [CALL], sessionState: withAlias }),
    );
    // The alias is claimed before the step that can start a remote child.
    expect(claimSessionHooks).toHaveBeenCalledWith(expect.arrayContaining([ALIAS]));
    expect(claimSessionHooks.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startAgentTasksStep).mock.invocationCallOrder[1]!,
    );
  });

  it("starts local calls in one step", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );

    await startAgentTasks(cursor, [CALL]);

    expect(startAgentTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ calls: [CALL] }),
    );
  });

  it("starts the pending batch's calls when given none", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );

    await startAgentTasks(cursor, undefined);

    expect(startAgentTasksStep).toHaveBeenCalledOnce();
    expect(vi.mocked(startAgentTasksStep).mock.calls[0]![0].calls).toBeUndefined();
  });
});

describe("applyTaskOwnerUpdate", () => {
  it("answers a ctx.agent caller while it publishes the update's events", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    const event: UnstampedMessageStreamEvent = {
      data: { callId: "call-1", output: "done", status: "completed", taskId: "research-abc234" },
      type: "task.settled",
    };
    const published = Promise.withResolvers<{
      serializedContext: Record<string, unknown>;
      sessionState: DurableSessionState;
    }>();
    vi.mocked(emitSubagentEventStep).mockReturnValue(published.promise);
    const result = {
      callId: "call-1",
      kind: "subagent-result",
      origin: "child",
      output: "done",
      subagentName: "research",
    } as never;

    let applied = false;
    const applying = applyTaskOwnerUpdate(cursor, {
      events: [event],
      replies: [{ replyTo: "reply-hook", result }],
      results: [],
      serializedContext: {},
      sessionState: cursor.sessionState,
    }).then(() => {
      applied = true;
    });

    // The reply does not wait for the event.
    await vi.waitFor(() =>
      expect(resumeHookStep).toHaveBeenCalledExactlyOnceWith(
        "reply-hook",
        { kind: "runtime-action-result", results: [result] },
        { ifPresent: true },
      ),
    );
    // The owner moves on only once the event is published.
    expect(applied).toBe(false);
    published.resolve({ serializedContext: {}, sessionState: cursor.sessionState });
    await applying;
    expect(applied).toBe(true);
  });
});

describe("cancelTasks", () => {
  it("publishes the task.settled event of each task it cancels", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    const event: UnstampedMessageStreamEvent = {
      data: { callId: "call-1", status: "cancelled", taskId: "research-abc234" },
      type: "task.settled",
    };
    vi.mocked(cancelTasksStep).mockResolvedValue({
      events: [event],
      replies: [],
      results: [],
      serializedContext: {},
      sessionState: cursor.sessionState,
    });
    vi.mocked(emitSubagentEventStep).mockImplementation(async (input) => ({
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));

    await cancelTasks(cursor, { kind: "workflow-run", runId: "run-1" });

    expect(cancelTasksStep).toHaveBeenCalledWith(
      expect.objectContaining({ selector: { kind: "workflow-run", runId: "run-1" } }),
    );
    expect(emitSubagentEventStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event }),
    );
  });
});

describe("cancelTurnDescendants", () => {
  it("cancels the active turn's tasks and returns without waiting on any child", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    vi.mocked(cancelTasksStep).mockResolvedValue({
      events: [],
      replies: [],
      results: [],
      serializedContext: {},
      sessionState: cursor.sessionState,
    });

    await cancelTurnDescendants(cursor);

    expect(cancelTasksStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ selector: { kind: "active-turn" } }),
    );
  });
});

describe("settleWorkflowTask", () => {
  it("publishes the settled event and returns the waiting call's tool result", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    const event: UnstampedMessageStreamEvent = {
      data: { callId: "call-1", output: "done", status: "completed", taskId: "deploy-abc234" },
      type: "task.settled",
    };
    const result = {
      callId: "call-1",
      kind: "tool-result" as const,
      output: "done",
      toolName: "deploy",
    };
    vi.mocked(settleWorkflowTaskStep).mockResolvedValue({
      events: [event],
      replies: [],
      results: [result],
      serializedContext: {},
      sessionState: cursor.sessionState,
    });
    vi.mocked(emitSubagentEventStep).mockImplementation(async (input) => ({
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
    const message = {
      from: {
        callId: "call-1",
        input: {},
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        taskId: "deploy-abc234",
        toolName: "deploy",
        turnId: "turn-1",
      },
      result: { output: "done", status: "completed" as const },
    };

    await expect(settleWorkflowTask(cursor, message)).resolves.toEqual([result]);

    expect(settleWorkflowTaskStep).toHaveBeenCalledWith(expect.objectContaining({ message }));
    expect(emitSubagentEventStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event }),
    );
  });
});

describe("syncTaskTimer", () => {
  const DEADLINE = "2026-09-24T14:00:00.000Z";
  const BEFORE_DEADLINE = Date.parse("2026-09-24T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: BEFORE_DEADLINE, toFake: ["Date"] });
    vi.mocked(armTaskTimerStep).mockImplementation(async (input) => ({
      sessionState: stateWith({
        ...input.sessionState.snapshot.session.state,
        [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner-1", runId: "timer-new", wakeAt: input.wakeAt },
      }),
    }));
    vi.mocked(cancelTaskTimerStep).mockImplementation(async (input) => {
      const { [TASK_TIMER_STATE_KEY]: _timer, ...state } =
        input.sessionState.snapshot.session.state ?? {};
      return { sessionState: stateWith(state) };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms the timer once an owner update records a deadline", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    vi.mocked(startAgentTasksStep).mockResolvedValue({
      events: [],
      replies: [],
      results: [],
      serializedContext: {},
      sessionState: stateWith(taskTableState([createTaskRecord({ deadlineAt: DEADLINE })])),
    });

    await startAgentTasks(cursor, [CALL]);

    expect(armTaskTimerStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ wakeAt: DEADLINE }),
    );
    expect(cursor.sessionState.snapshot.session.state?.[TASK_TIMER_STATE_KEY]).toEqual({
      ownerRunId: "owner-1",
      runId: "timer-new",
      wakeAt: DEADLINE,
    });
  });

  it("keeps a timer this owner armed that fires no later than the next deadline", async () => {
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
        [TASK_TIMER_STATE_KEY]: {
          ownerRunId: "owner-1",
          runId: "timer-1",
          wakeAt: "2026-09-24T13:00:00.000Z",
        },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).not.toHaveBeenCalled();
    expect(cancelTaskTimerStep).not.toHaveBeenCalled();
  });

  it("re-arms when a deadline is earlier than the armed timer", async () => {
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
        [TASK_TIMER_STATE_KEY]: {
          ownerRunId: "owner-1",
          runId: "timer-1",
          wakeAt: "2026-09-24T15:00:00.000Z",
        },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ wakeAt: DEADLINE }),
    );
  });

  it("re-arms a timer a predecessor owner armed, which may have retired with its deployment", async () => {
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
        [TASK_TIMER_STATE_KEY]: {
          ownerRunId: "owner-0",
          runId: "timer-1",
          wakeAt: "2026-09-24T13:00:00.000Z",
        },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ wakeAt: DEADLINE }),
    );
  });

  it("re-arms for now when the armed timer's signal is overdue", async () => {
    vi.setSystemTime(Date.parse("2026-09-24T14:05:00.000Z"));
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
        [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner-1", runId: "timer-1", wakeAt: DEADLINE },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ wakeAt: "2026-09-24T14:05:00.000Z" }),
    );
  });

  it("cancels the armed timer once no task needs a wake", async () => {
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord()]),
        [TASK_TIMER_STATE_KEY]: { ownerRunId: "owner-1", runId: "timer-1", wakeAt: DEADLINE },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).not.toHaveBeenCalled();
    expect(cancelTaskTimerStep).toHaveBeenCalledOnce();
    expect(cursor.sessionState.snapshot.session.state?.[TASK_TIMER_STATE_KEY]).toBeUndefined();
  });

  it("arms nothing when no task has a deadline and no timer is armed", async () => {
    const cursor = createCursor(
      stateWith(taskTableState([createTaskRecord()])),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).not.toHaveBeenCalled();
    expect(cancelTaskTimerStep).not.toHaveBeenCalled();
  });

  it("keeps a timer a step armed for a due deadline on a clock ahead of the workflow's", async () => {
    // The step armed the due deadline for its own time, two seconds ahead.
    vi.setSystemTime(Date.parse("2026-09-24T14:00:10.000Z"));
    const cursor = createCursor(
      stateWith({
        ...taskTableState([createTaskRecord({ deadlineAt: DEADLINE })]),
        [TASK_TIMER_STATE_KEY]: {
          ownerRunId: "owner-1",
          runId: "timer-1",
          wakeAt: "2026-09-24T14:00:12.000Z",
        },
      }),
      vi.fn(async () => {}),
    );

    await syncTaskTimer(cursor);

    expect(armTaskTimerStep).not.toHaveBeenCalled();
  });
});

describe("closeTaskOwnerInbox", () => {
  const started = {
    callId: "call-1",
    child: { continuationToken: "child-token", sessionId: "child-session" },
    kind: "task.started" as const,
  };

  function fakeInbox(unread: readonly SessionInboxPayload[]) {
    const calls: string[] = [];
    return {
      calls,
      inbox: {
        dispose: vi.fn(async () => {
          calls.push("dispose");
        }),
        release: vi.fn(async () => {
          calls.push("release");
          return [...unread];
        }),
      },
    };
  }

  beforeEach(() => {
    vi.mocked(applyTaskReportStep).mockImplementation(async (input) => ({
      events: [],
      replies: [],
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
    vi.mocked(armTaskTimerStep).mockImplementation(async (input) => ({
      sessionState: input.sessionState,
    }));
  });

  it("adopts a starting child that reported as the session ended, so its held cancel is sent", async () => {
    // The task was cancelled while its child was starting, so the cancel waits for its address.
    const starting = createTaskRecord({
      cancelConfirmBy: "2026-09-24T14:00:30.000Z",
      delivered: true,
      pendingCommands: [{ kind: "cancel" }],
      status: "cancelled",
    });
    const claimSessionHooks = vi.fn(async () => {});
    const cursor = createCursor(stateWith(taskTableState([starting])), claimSessionHooks);
    const { calls, inbox } = fakeInbox([send("too late"), started]);

    await closeTaskOwnerInbox(cursor, inbox);

    // Released first, so every report the inbox accepted is read before it closes.
    expect(calls).toEqual(["release", "dispose"]);
    expect(applyTaskReportStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ payload: started }),
    );
  });

  it("only disposes the inbox when no child is starting", async () => {
    const cursor = createCursor(
      stateWith(
        taskTableState([
          createTaskRecord({
            child: { continuationToken: "child-token", kind: "local", sessionId: "child-session" },
          }),
        ]),
      ),
      vi.fn(async () => {}),
    );
    const { calls, inbox } = fakeInbox([started]);

    await closeTaskOwnerInbox(cursor, inbox);

    expect(calls).toEqual(["dispose"]);
    expect(applyTaskReportStep).not.toHaveBeenCalled();
  });

  it("disposes the inbox even when the release fails", async () => {
    const cursor = createCursor(
      stateWith(taskTableState([createTaskRecord()])),
      vi.fn(async () => {}),
    );
    const failure = new Error("release failed");
    const { calls, inbox } = fakeInbox([]);
    inbox.release.mockRejectedValue(failure);

    await expect(closeTaskOwnerInbox(cursor, inbox)).rejects.toBe(failure);
    expect(calls).toEqual(["dispose"]);
  });
});

describe("applyTaskDeadline", () => {
  it("publishes the timed-out task's event and returns the waiting call's result", async () => {
    const cursor = createCursor(
      createTestSessionState(),
      vi.fn(async () => {}),
    );
    const event: UnstampedMessageStreamEvent = {
      data: {
        callId: "call-1",
        error: { code: "TIMED_OUT", message: "Timed out." },
        status: "failed",
        taskId: "research-abc234",
      },
      type: "task.settled",
    };
    const result = {
      callId: "call-1",
      isError: true,
      kind: "tool-result" as const,
      output: { code: "TIMED_OUT", message: "Timed out." },
      toolName: "research",
    };
    vi.mocked(applyTaskDeadlinesStep).mockResolvedValue({
      events: [event],
      replies: [],
      results: [result],
      serializedContext: {},
      sessionState: cursor.sessionState,
    });
    vi.mocked(emitSubagentEventStep).mockImplementation(async (input) => ({
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    }));
    const signal = {
      kind: "task.deadline" as const,
      ownerRunId: "owner",
      wakeAt: "2026-09-24T14:00:00.000Z",
    };

    await expect(applyTaskDeadline(cursor, signal)).resolves.toEqual([result]);

    expect(applyTaskDeadlinesStep).toHaveBeenCalledWith(expect.objectContaining({ signal }));
    expect(emitSubagentEventStep).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event }),
    );
  });
});

function send(message: string): SessionInboxPayload {
  return { kind: "send", payload: { message } };
}

function stateWith(state: SessionStateMap): DurableSessionState {
  const base = createTestSessionState();
  return { ...base, snapshot: { session: { ...base.snapshot.session, state } } };
}

function stateWithAlias(): DurableSessionState {
  const state = createTestSessionState();
  return {
    ...state,
    snapshot: {
      session: { ...state.snapshot.session, state: { [TASK_CALLBACK_ALIAS_STATE_KEY]: ALIAS } },
    },
  };
}

function createCursor(
  sessionState: DurableSessionState,
  claimSessionHooks: (tokens: readonly string[]) => Promise<void>,
): SessionStateCursor {
  return new SessionStateCursor({
    inbox: { claimSessionHooks },
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}
