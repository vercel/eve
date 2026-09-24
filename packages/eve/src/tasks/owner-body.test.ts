import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionStateMap } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { applyTaskDeadlinesStep } from "#tasks/deadlines.js";
import {
  applyTaskDeadline,
  cancelTasks,
  cancelTurnDescendants,
  settleWorkflowTask,
  startAgentTasks,
  syncTaskTimer,
} from "#tasks/owner-body.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import { ensureTaskCallbackAliasStep, startAgentTasksStep } from "#tasks/owner.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY, TASK_TIMER_STATE_KEY } from "#tasks/state.js";
import { armTaskTimerStep, cancelTaskTimerStep } from "#tasks/timer-steps.js";
import { settleWorkflowTaskStep } from "#tasks/workflow-task.js";

vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
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
  ensureTaskCallbackAliasStep: vi.fn(),
  startAgentTasksStep: vi.fn(),
}));
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
  it("records and claims the callback alias before any child can start", async () => {
    const withAlias = stateWithAlias();
    vi.mocked(ensureTaskCallbackAliasStep).mockResolvedValue({ sessionState: withAlias });
    const claimSessionHooks = vi.fn(async () => {});
    const cursor = createCursor(createTestSessionState(), claimSessionHooks);

    await startAgentTasks(cursor, [CALL]);

    expect(startAgentTasksStep).toHaveBeenCalledWith(
      expect.objectContaining({ calls: [CALL], sessionState: withAlias }),
    );
    expect(claimSessionHooks).toHaveBeenCalledWith(expect.arrayContaining([ALIAS]));
    expect(claimSessionHooks.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(startAgentTasksStep).mock.invocationCallOrder[0]!,
    );
  });

  it("reuses the alias the session already recorded", async () => {
    const cursor = createCursor(
      stateWithAlias(),
      vi.fn(async () => {}),
    );

    await startAgentTasks(cursor, [CALL]);

    expect(ensureTaskCallbackAliasStep).not.toHaveBeenCalled();
    expect(startAgentTasksStep).toHaveBeenCalledOnce();
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
    vi.mocked(ensureTaskCallbackAliasStep).mockResolvedValue({ sessionState: stateWithAlias() });

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
