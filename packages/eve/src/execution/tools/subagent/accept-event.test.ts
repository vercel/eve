import { beforeEach, describe, expect, it, vi } from "vitest";

import { readDurableSession } from "#execution/session/state.js";
import { readLatestTaskView } from "#execution/tasks/runtime.js";
import { acceptTaskAuthorizationEvent } from "#execution/tools/subagent/accept-event.js";
import { setAgentHandleStore } from "#subagents/handles/store.js";
import { cacheTerminalTaskView } from "#tasks/session-index.js";

vi.mock("#execution/session/state.js", () => ({ readDurableSession: vi.fn() }));
vi.mock("#execution/tasks/runtime.js", () => ({ readLatestTaskView: vi.fn() }));

const sessionState: import("#execution/session/state.js").DurableSessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  snapshot: {
    session: {
      agent: { system: "" },
      continuationToken: "parent-token",
      history: [],
      sessionId: "parent-session",
      state: {},
    },
  },
};
const hookPayload = {
  callId: "call-1",
  childSessionId: "child-1",
  event: {
    data: {
      description: "Authorize Linear",
      name: "linear",
      sequence: 1,
      stepIndex: 2,
      turnId: "turn-child",
    },
    type: "authorization.required" as const,
  },
  kind: "subagent-authorization-event" as const,
  subagentName: "research",
};
const taskIndex = {
  "eve.tasks": {
    tasks: [
      {
        createdByTurnId: "turn-1",
        metadata: { kind: "tool", name: "export" },
        taskId: "task-1",
        taskInboxToken: "task-token",
        taskRunId: "task-run",
      },
    ],
    version: 2,
  },
};

function mockSession(handles: readonly unknown[]): void {
  vi.mocked(readDurableSession).mockReturnValue({
    agent: { system: "" },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state: setAgentHandleStore(taskIndex, { handles: handles as never }),
  });
}

describe("acceptTaskAuthorizationEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSession([
      {
        address: {
          callbackBaseUrl: "https://parent.example",
          kind: "agent/remote",
          sessionId: "child-1",
          url: "https://remote.example",
        },
        identity: { id: "agent-1", name: "research", nodeId: "node-1" },
        operationId: "operation-1",
        phase: "claimed",
        ownerId: "task-1",
      },
    ]);
    vi.mocked(readLatestTaskView).mockResolvedValue({
      metadata: { kind: "tool", name: "export" },
      status: "working",
      taskId: "task-1",
    });
  });

  it("accepts an authorization event from the task's claimed child agent", async () => {
    await expect(
      acceptTaskAuthorizationEvent({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
    expect(readLatestTaskView).not.toHaveBeenCalled();
  });

  it("accepts the owning workflow tool's event without an agent handle", async () => {
    mockSession([]);
    const event = {
      ...hookPayload,
      childSessionId: "task-run",
      subagentName: "export",
      event: { ...hookPayload.event, data: { ...hookPayload.event.data, turnId: "turn-1" } },
    };
    await expect(
      acceptTaskAuthorizationEvent({
        delivery: { hookPayload: event, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
    await expect(
      acceptTaskAuthorizationEvent({
        delivery: { hookPayload: { ...event, childSessionId: "different-run" }, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(false);
  });

  it("accepts the first authorization event while the task child start is still reserved", async () => {
    mockSession([
      {
        identity: { id: "agent-1", name: "research", nodeId: "node-1" },
        operationId: "operation-1",
        phase: "reserved",
        ownerId: "task-1",
      },
    ]);

    await expect(
      acceptTaskAuthorizationEvent({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
  });

  it("rejects an authorization event from a child session not claimed by the task", async () => {
    await expect(
      acceptTaskAuthorizationEvent({
        delivery: {
          hookPayload: { ...hookPayload, childSessionId: "other-child" },
          taskId: "task-1",
        },
        sessionState,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an authorization event once the task is terminal", async () => {
    const session = readDurableSession(sessionState);
    vi.mocked(readDurableSession).mockReturnValue({
      ...session,
      state: cacheTerminalTaskView(session.state, {
        lastOutput: { data: "done", type: "result" },
        metadata: { kind: "tool", name: "export" },
        status: "completed",
        taskId: "task-1",
      }),
    });

    await expect(
      acceptTaskAuthorizationEvent({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(false);
  });
});
