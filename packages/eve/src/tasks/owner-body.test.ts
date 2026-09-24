import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitSubagentEventStep } from "#execution/tools/subagent/emit-event-step.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { cancelTasks, startAgentTasks } from "#tasks/owner-body.js";
import { cancelTasksStep, ensureTaskCallbackAliasStep, startAgentTasksStep } from "#tasks/owner.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY } from "#tasks/state.js";

vi.mock("#execution/tools/subagent/emit-event-step.js", () => ({
  emitSubagentEventStep: vi.fn(),
}));
vi.mock("#tasks/owner.js", () => ({
  applyTaskReportStep: vi.fn(),
  cancelTasksStep: vi.fn(),
  ensureTaskCallbackAliasStep: vi.fn(),
  startAgentTasksStep: vi.fn(),
}));

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
