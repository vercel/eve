import { beforeEach, expect, it, vi } from "vitest";

import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import type { TaskRecord } from "#tasks/record.js";

vi.mock("#subagents/event-proxy-step.js", () => ({ runProxySubagentEventStep: vi.fn() }));

const CHILD = { continuationToken: "child-token", kind: "local" as const, sessionId: "child-1" };

const inputRequest: SubagentInputRequestHookPayload = {
  callId: "call-1",
  childContinuationToken: "child-token",
  childSessionId: "child-1",
  event: { requests: [], sequence: 1, stepIndex: 0, turnId: "child-turn" },
  kind: "subagent-input-request",
  subagentName: "research",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(runProxySubagentEventStep).mockImplementation(async (input) => ({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  }));
});

it("proxies a working task's child request with the task's ID", async () => {
  const cursor = createCursor([createTaskRecord({ child: CHILD })]);

  await expect(
    admitSessionInboxPayload(inputRequest, { cursor, queue: new SessionInputQueue() }),
  ).resolves.toEqual({ kind: "consumed" });

  expect(runProxySubagentEventStep).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ hookPayload: inputRequest, taskId: "research-abc234" }),
  );
});

it("drops a request that matches no working task", async () => {
  const cursor = createCursor([createTaskRecord({ child: CHILD, status: "cancelled" })]);

  await admitSessionInboxPayload(inputRequest, { cursor, queue: new SessionInputQueue() });

  expect(runProxySubagentEventStep).not.toHaveBeenCalled();
});

function createCursor(records: readonly TaskRecord[]): SessionStateCursor {
  const base = createTestSessionState();
  const sessionState: DurableSessionState = {
    ...base,
    snapshot: { session: { ...base.snapshot.session, state: taskTableState(records) } },
  };
  return new SessionStateCursor({
    inbox: { claimSessionHooks: vi.fn() },
    serializedContext: {},
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>(),
  });
}
