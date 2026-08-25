import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentAuthorizationEventHookPayload } from "#channel/types.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { readTaskView } from "#execution/tasks/parent/control-shared.js";
import { acceptTaskAuthorizationEventStep } from "#execution/tasks/parent/hitl-proxy-steps.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#execution/durable-session-store.js", () => ({
  readDurableSession: vi.fn(),
}));
vi.mock("#execution/tasks/parent/control-shared.js", () => ({
  readTaskView: vi.fn(),
}));
vi.mock("#harness/handles/store.js", () => ({
  getAgentHandleStore: vi.fn(),
}));
vi.mock("#tasks/session-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#tasks/session-index.js")>()),
  findSessionTaskEntry: vi.fn(),
}));

const metadata = {
  agentId: "ag_research:abcdef123456",
  kind: "subagent" as const,
  mode: "local" as const,
  name: "research",
};
const entry = {
  createdByTurnId: "turn-parent",
  metadata,
  taskId: "task-1",
  taskInboxToken: "task-token",
  taskRunId: "task-run-1",
};
const sessionState: DurableSessionState = {
  continuationToken: "parent-token",
  emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn-parent" },
  hasProxyInputRequests: true,
  sessionId: "parent-session",
  version: 1,
};

function approvalSettled(): SubagentAuthorizationEventHookPayload {
  return {
    callId: "call-task",
    childSessionId: "child-session",
    event: {
      data: {
        outcome: "approved",
        requestId: "request-1",
        responderPrincipalId: "user-1",
        sequence: 1,
        stepIndex: 2,
        turnId: "turn-child",
      },
      type: "approval.settled",
    },
    kind: "subagent-authorization-event",
    subagentName: "research",
  };
}

function view(status: "working" | "completed" = "working"): TaskView {
  const base = {
    executor: {
      childSessionId: "child-session",
      lifecycle: status === "completed" ? ("terminal" as const) : ("parked" as const),
    },
    metadata,
    taskId: "task-1",
  };
  return status === "completed"
    ? { ...base, lastOutput: { data: "done", type: "result" }, status }
    : { ...base, status };
}

function mockAddressedHandle(): void {
  vi.mocked(getAgentHandleStore).mockReturnValue({
    handles: [
      {
        address: {
          continuationToken: "child-token",
          kind: "agent/local",
          sessionId: "child-session",
        },
        identity: { id: metadata.agentId, name: "research", nodeId: "agent/research" },
        phase: "addressed",
      },
    ],
  });
}

describe("acceptTaskAuthorizationEventStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readDurableSession).mockResolvedValue({ state: {} } as never);
    vi.mocked(findSessionTaskEntry).mockReturnValue(entry);
    vi.mocked(readTaskView).mockResolvedValue(view());
    mockAddressedHandle();
  });

  it("namespaces approval lifecycle request ids for the parent channel", async () => {
    const hookPayload = approvalSettled();

    await expect(
      acceptTaskAuthorizationEventStep({ hookPayload, sessionState, taskId: "task-1" }),
    ).resolves.toEqual({
      accepted: true,
      hookPayload: {
        ...hookPayload,
        event: {
          ...hookPayload.event,
          data: { ...hookPayload.event.data, requestId: "task-1:request-1" },
        },
      },
    });
  });

  it("accepts a late approval settlement after the terminal view removes its handle", async () => {
    vi.mocked(readTaskView).mockResolvedValue(view("completed"));
    vi.mocked(getAgentHandleStore).mockReturnValue(undefined);

    const result = await acceptTaskAuthorizationEventStep({
      hookPayload: approvalSettled(),
      sessionState,
      taskId: "task-1",
    });

    expect(result.accepted).toBe(true);
  });

  it("rejects approval lifecycle events from a different child session", async () => {
    const hookPayload = { ...approvalSettled(), childSessionId: "other-child" };

    await expect(
      acceptTaskAuthorizationEventStep({ hookPayload, sessionState, taskId: "task-1" }),
    ).resolves.toEqual({ accepted: false });
  });

  it("keeps authorization blocker events on the strict nonterminal path", async () => {
    const hookPayload = {
      ...approvalSettled(),
      event: {
        data: {
          description: "Sign in",
          name: "github",
          sequence: 1,
          stepIndex: 2,
          turnId: "turn-child",
        },
        type: "authorization.required" as const,
      },
    } satisfies SubagentAuthorizationEventHookPayload;

    await expect(
      acceptTaskAuthorizationEventStep({ hookPayload, sessionState, taskId: "task-1" }),
    ).resolves.toEqual({ accepted: true, hookPayload });

    vi.mocked(readTaskView).mockResolvedValue(view("completed"));
    await expect(
      acceptTaskAuthorizationEventStep({ hookPayload, sessionState, taskId: "task-1" }),
    ).resolves.toEqual({ accepted: false });
  });
});
