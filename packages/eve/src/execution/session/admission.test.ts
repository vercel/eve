import { beforeEach, expect, it, vi } from "vitest";

import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { runProxySubagentEventStep } from "#subagents/event-proxy-step.js";
import { cancelTasks } from "#tasks/owner-body.js";
import type { TaskRecord } from "#tasks/record.js";

vi.mock("#subagents/event-proxy-step.js", () => ({ runProxySubagentEventStep: vi.fn() }));
vi.mock("#tasks/owner-body.js", () => ({ cancelTasks: vi.fn() }));

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

it("admits the owner timer's signal for the deadline step", async () => {
  const signal = {
    kind: "task.deadline" as const,
    ownerRunId: "previous-owner",
    wakeAt: "2026-09-24T14:00:00.000Z",
  };

  await expect(
    admitSessionInboxPayload(signal, { cursor: createCursor([]), queue: new SessionInputQueue() }),
  ).resolves.toEqual({ kind: "task-deadline", signal });
});

it("cancels one task on admission and leaves the turn running", async () => {
  const cursor = createCursor([]);

  await expect(
    admitSessionInboxPayload(
      { kind: "cancel", taskId: "remind-q4x1ze" },
      { cursor, queue: new SessionInputQueue() },
    ),
  ).resolves.toEqual({ kind: "consumed" });

  expect(cancelTasks).toHaveBeenCalledExactlyOnceWith(cursor, {
    kind: "task",
    taskId: "remind-q4x1ze",
  });
});

it("cancels background tasks and leaves the turn's calls to turn cancellation for tasks: true", async () => {
  const cursor = createCursor([]);
  const command = { kind: "cancel" as const, tasks: true };

  await expect(
    admitSessionInboxPayload(command, { cursor, queue: new SessionInputQueue() }),
  ).resolves.toEqual({ command, kind: "cancel" });

  expect(cancelTasks).toHaveBeenCalledExactlyOnceWith(cursor, { kind: "background" });
});

it("leaves tasks alone for a plain turn cancel", async () => {
  const command = { kind: "cancel" as const };

  await expect(
    admitSessionInboxPayload(command, { cursor: createCursor([]), queue: new SessionInputQueue() }),
  ).resolves.toEqual({ command, kind: "cancel" });

  expect(cancelTasks).not.toHaveBeenCalled();
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
