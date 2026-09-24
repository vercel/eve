import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { startAgentTasks } from "#tasks/owner-body.js";
import { ensureTaskCallbackAliasStep, startAgentTasksStep } from "#tasks/owner.js";
import { TASK_CALLBACK_ALIAS_STATE_KEY } from "#tasks/state.js";

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
