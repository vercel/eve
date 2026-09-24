import { recordWorkflowTaskView } from "#harness/workflow-tool-runs.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readDurableSession } from "#execution/durable-session-store.js";
import { acceptTaskAuthorizationEventStep } from "#execution/tools/subagent/accept-event-step.js";
import { setAgentHandleStore } from "#subagents/handles/store.js";

vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: vi.fn(),
}));

const sessionState = createTestSessionState({
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-1" },
  hasProxyInputRequests: false,
  sessionId: "parent-session",
  version: 1,
});
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
  "eve.workflowTool": {
    version: 3,
    runs: [
      {
        callId: "task-1",
        toolName: "export",
        lifetime: "session" as const,
        origin: { turnId: "turn-1", stepIndex: 0 },
        address: { runId: "task-run", hookToken: "task-token" },
        task: {
          dispatchContext: { auth: { current: null, initiator: null } },
          metadata: { kind: "tool", name: "export" },
          taskId: "task-1",
        },
      },
    ],
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

describe("acceptTaskAuthorizationEventStep", () => {
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
  });

  it("accepts an authorization event from the task's claimed child agent", async () => {
    await expect(
      acceptTaskAuthorizationEventStep({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
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
      acceptTaskAuthorizationEventStep({
        delivery: { hookPayload: event, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
    await expect(
      acceptTaskAuthorizationEventStep({
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
      acceptTaskAuthorizationEventStep({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(true);
  });

  it("rejects an authorization event from a child session not claimed by the task", async () => {
    await expect(
      acceptTaskAuthorizationEventStep({
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
      state: recordWorkflowTaskView(session.state, {
        lastOutput: { data: "done", type: "result" },
        metadata: { kind: "tool", name: "export" },
        status: "completed",
        taskId: "task-1",
      }).state,
    });

    await expect(
      acceptTaskAuthorizationEventStep({
        delivery: { hookPayload, taskId: "task-1" },
        sessionState,
      }),
    ).resolves.toBe(false);
  });
});
