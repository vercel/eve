import { beforeEach, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { admitSessionInboxPayload } from "#execution/session/admission.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import { surfaceTaskInput } from "#tasks/owner-body.js";
import type { TaskInputHookPayload } from "#tasks/protocol.js";
import type { TaskRecord } from "#tasks/record.js";

vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));
vi.mock("#tasks/owner-body.js", () => ({ surfaceTaskInput: vi.fn() }));

const CHILD = { continuationToken: "child-token", kind: "local" as const, sessionId: "child-1" };

const inputRequest: TaskInputHookPayload = {
  callId: "call-1",
  childSessionId: "child-1",
  event: {
    data: { requests: [], sequence: 1, stepIndex: 0, turnId: "child-turn" },
    type: "input.requested",
  },
  kind: "task.input",
  subagentName: "research",
};

beforeEach(() => {
  vi.resetAllMocks();
});

it("surfaces a working task's child request with the task's ID", async () => {
  const cursor = createCursor([createTaskRecord({ child: CHILD })]);

  await expect(
    admitSessionInboxPayload(inputRequest, { cursor, queue: new SessionInputQueue() }),
  ).resolves.toEqual({ kind: "consumed" });

  expect(surfaceTaskInput).toHaveBeenCalledExactlyOnceWith(
    cursor,
    "research-abc234",
    inputRequest.event,
  );
});

it("drops a request that matches no working task", async () => {
  const cursor = createCursor([createTaskRecord({ child: CHILD, status: "cancelled" })]);

  await admitSessionInboxPayload(inputRequest, { cursor, queue: new SessionInputQueue() });

  expect(surfaceTaskInput).not.toHaveBeenCalled();
});

const REMOTE_CHILD = {
  callbackBaseUrl: "https://owner.example",
  kind: "remote" as const,
  sessionId: "remote-1",
  url: "https://billing.example",
};
const remoteRequest: TaskInputHookPayload = {
  ...inputRequest,
  childSessionId: "remote-1",
  source: { kind: "remote" },
};

it("surfaces a remote child's request, marked by the callback route, with the task's ID", async () => {
  const cursor = createCursor([createTaskRecord({ child: REMOTE_CHILD })]);

  await admitSessionInboxPayload(remoteRequest, { cursor, queue: new SessionInputQueue() });

  expect(surfaceTaskInput).toHaveBeenCalledExactlyOnceWith(
    cursor,
    "research-abc234",
    remoteRequest.event,
  );
});

it.each([
  ["a remote request for a local child", remoteRequest, CHILD],
  [
    "a remote request from another remote session",
    { ...remoteRequest, childSessionId: "remote-2" },
    REMOTE_CHILD,
  ],
  ["an unmarked request for a remote child", inputRequest, REMOTE_CHILD],
])("drops %s", async (_label, request, child) => {
  const cursor = createCursor([createTaskRecord({ child })]);

  await admitSessionInboxPayload(request, { cursor, queue: new SessionInputQueue() });

  expect(surfaceTaskInput).not.toHaveBeenCalled();
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

it("admits a cancel and leaves its tasks to the turn, or the idle owner, that applies it", async () => {
  const command = { kind: "cancel" as const, turnId: "turn_3" };

  await expect(
    admitSessionInboxPayload(command, { cursor: createCursor([]), queue: new SessionInputQueue() }),
  ).resolves.toEqual({ command, kind: "cancel" });
});

it("admits this owner's session expiry as a cancel and queues the session's end", async () => {
  const queue = new SessionInputQueue();

  await expect(
    admitSessionInboxPayload(
      { kind: "session-timeout", ownerRunId: "owner-1" },
      { cursor: createCursor([]), queue },
    ),
  ).resolves.toEqual({ command: { kind: "cancel" }, kind: "cancel" });
  expect(queue.takeNext()).toEqual({ control: "expired", kind: "control" });
});

it("ignores a previous owner's session expiry", async () => {
  const queue = new SessionInputQueue();

  await expect(
    admitSessionInboxPayload(
      { kind: "session-timeout", ownerRunId: "previous-owner" },
      { cursor: createCursor([]), queue },
    ),
  ).resolves.toEqual({ kind: "consumed" });
  expect(queue.pendingCount).toBe(0);
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
