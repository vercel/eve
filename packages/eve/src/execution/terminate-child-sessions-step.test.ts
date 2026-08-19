import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#harness/handles/store.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { SESSION_TASKS_STATE_KEY, type SessionTaskIndexEntry } from "#tasks/session-index.js";

const {
  cancelOwnedTaskMock,
  cancelRunMock,
  deserializeContextMock,
  getWorldMock,
  hydrateDurableSessionMock,
  resolveEffectiveAgentRuntimeMock,
} = vi.hoisted(() => ({
  cancelOwnedTaskMock: vi.fn(),
  cancelRunMock: vi.fn(),
  deserializeContextMock: vi.fn(),
  getWorldMock: vi.fn(),
  hydrateDurableSessionMock: vi.fn(),
  resolveEffectiveAgentRuntimeMock: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: deserializeContextMock,
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: resolveEffectiveAgentRuntimeMock,
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: hydrateDurableSessionMock,
}));
vi.mock("#execution/tasks/parent/dispatch.js", () => ({
  cancelOwnedTask: cancelOwnedTaskMock,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: cancelRunMock,
  getWorld: getWorldMock,
}));

describe("terminateChildSessionsStep", () => {
  beforeEach(() => {
    cancelOwnedTaskMock.mockReset();
    cancelOwnedTaskMock.mockResolvedValue(undefined);
    cancelRunMock.mockReset();
    cancelRunMock.mockResolvedValue(undefined);
    deserializeContextMock.mockReset();
    deserializeContextMock.mockResolvedValue({ require: vi.fn().mockReturnValue("bundle") });
    getWorldMock.mockReset();
    getWorldMock.mockResolvedValue("world");
    hydrateDurableSessionMock.mockReset();
    hydrateDurableSessionMock.mockReturnValue("runtime-session");
    resolveEffectiveAgentRuntimeMock.mockReset();
    resolveEffectiveAgentRuntimeMock.mockReturnValue({ turnAgent: "turn-agent" });
  });

  it("terminates running and parked local/self children", async () => {
    const handles = [
      runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" }),
      parkedHandle({ id: "ag_self:1", kind: "agent/self", sessionId: "session-self" }),
    ];

    await terminateChildSessionsStep({
      sessionState: makeSessionState(handles),
    });

    expect(cancelRunMock).toHaveBeenCalledTimes(2);
    expect(cancelRunMock).toHaveBeenNthCalledWith(1, "world", "session-local", {
      cancelReason: "Parent session ended",
    });
    expect(cancelRunMock).toHaveBeenNthCalledWith(2, "world", "session-self", {
      cancelReason: "Parent session ended",
    });
  });

  it("skips remote handles: remote children survive parent termination (documented gap)", async () => {
    await terminateChildSessionsStep({
      sessionState: makeSessionState([
        parkedHandle({ id: "ag_remote:1", kind: "agent/remote", sessionId: "session-remote" }),
        runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" }),
      ]),
    });

    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-local", {
      cancelReason: "Parent session ended",
    });
  });

  it("skips a starting handle that has no session id yet", async () => {
    await terminateChildSessionsStep({
      sessionState: makeSessionState([
        startingHandle({ id: "ag_local:starting", kind: "agent/local" }),
        parkedHandle({ id: "ag_self:1", kind: "agent/self", sessionId: "session-self" }),
      ]),
    });

    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-self", {
      cancelReason: "Parent session ended",
    });
  });

  it("settles every indexed task cancellation before terminating local children", async () => {
    const firstCancellation = createDeferred();
    const secondCancellation = createDeferred();
    const order: string[] = [];
    cancelOwnedTaskMock
      .mockImplementationOnce(async () => {
        await firstCancellation.promise;
        order.push("task-1-settled");
      })
      .mockImplementationOnce(async () => {
        await secondCancellation.promise;
        order.push("task-2-settled");
      });
    cancelRunMock.mockImplementation(async () => {
      order.push("child-cancelled");
    });

    const termination = terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState(
        [runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" })],
        [indexedTask("task-1"), indexedTask("task-2")],
      ),
    });

    await vi.waitFor(() => expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(1));
    expect(cancelRunMock).not.toHaveBeenCalled();

    firstCancellation.resolve();
    await vi.waitFor(() => expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["task-1-settled"]);
    expect(cancelRunMock).not.toHaveBeenCalled();

    secondCancellation.resolve();
    await termination;

    expect(order).toEqual(["task-1-settled", "task-2-settled", "child-cancelled"]);
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-local", {
      cancelReason: "Parent session ended",
    });
  });

  it("continues finalization after an indexed task cancellation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelOwnedTaskMock
      .mockRejectedValueOnce(new Error("task cancellation unavailable"))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(
        terminateChildSessionsStep({
          serializedContext: { context: "serialized" },
          sessionState: makeSessionState(
            [
              parkedHandle({
                id: "ag_local:1",
                kind: "agent/local",
                sessionId: "session-local",
              }),
            ],
            [indexedTask("task-1"), indexedTask("task-2")],
          ),
        }),
      ).resolves.toBeUndefined();

      expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(2);
      expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-local", {
        cancelReason: "Parent session ended",
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "[eve:execution.terminate-child-sessions] failed to cancel task during parent finalization",
        expect.objectContaining({
          parentSessionId: "parent-session",
          taskId: "task-1",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("continues terminating children after one termination fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelRunMock
      .mockRejectedValueOnce(new Error("termination unavailable"))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(
        terminateChildSessionsStep({
          sessionState: makeSessionState([
            runningHandle({ id: "ag_child:1", kind: "agent/local", sessionId: "session-1" }),
            parkedHandle({ id: "ag_child:2", kind: "agent/self", sessionId: "session-2" }),
          ]),
        }),
      ).resolves.toBeUndefined();

      expect(cancelRunMock).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        "[eve:execution.terminate-child-sessions] failed to terminate child session",
        expect.objectContaining({
          agentId: "ag_child:1",
          childSessionId: "session-1",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

type LocalAddressKind = "agent/local" | "agent/self";
type AddressKind = LocalAddressKind | "agent/remote";

function makeIdentity(id: string): { id: string; name: string; nodeId: string } {
  return { id, name: "research", nodeId: "subagents/research" };
}

function makeAddress(kind: AddressKind, sessionId: string) {
  return kind === "agent/remote"
    ? {
        callbackBaseUrl: "https://parent.example.com",
        kind,
        sessionId,
        url: "https://remote.example.com",
      }
    : { continuationToken: `${sessionId}:token`, kind, sessionId };
}

function runningHandle(input: {
  readonly id: string;
  readonly kind: AddressKind;
  readonly sessionId: string;
}): AgentHandle {
  return {
    address: makeAddress(input.kind, input.sessionId),
    identity: makeIdentity(input.id),
    operation: {
      callId: "call-1",
      id: `op-${input.id}`,
      kind: "start",
      parentTurnId: "turn-1",
    },
    phase: "running",
  };
}

function parkedHandle(input: {
  readonly id: string;
  readonly kind: AddressKind;
  readonly sessionId: string;
}): AgentHandle {
  return {
    address: makeAddress(input.kind, input.sessionId),
    identity: makeIdentity(input.id),
    lastStatus: "ready",
    phase: "parked",
  };
}

function startingHandle(input: {
  readonly id: string;
  readonly kind: LocalAddressKind;
}): AgentHandle {
  return {
    identity: makeIdentity(input.id),
    operation: {
      callId: "call-1",
      id: `op-${input.id}`,
      kind: "start",
      parentTurnId: "turn-1",
    },
    phase: "starting",
    target: { continuationToken: "pending:token", kind: input.kind },
  };
}

function indexedTask(taskId: string): SessionTaskIndexEntry {
  return {
    taskInboxToken: `${taskId}:inbox`,
    createdByTurnId: "turn-1",
    metadata: {
      agentId: "ag_local:1",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    operationId: `op-${taskId}`,
    taskId,
    taskRunId: `run-${taskId}`,
  };
}

function makeSessionState(
  handles: readonly AgentHandle[],
  tasks: readonly SessionTaskIndexEntry[] = [],
): DurableSessionState {
  return {
    continuationToken: "parent-token",
    emissionState: {
      sequence: 0,
      sessionStarted: true,
      stepIndex: 0,
      turnId: "turn-1",
    },
    hasProxyInputRequests: false,
    sessionId: "parent-session",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent-session",
        state:
          tasks.length === 0
            ? { [AGENT_HANDLES_STATE_KEY]: { handles } }
            : { [AGENT_HANDLES_STATE_KEY]: { handles }, [SESSION_TASKS_STATE_KEY]: { tasks } },
      },
      version: 1,
    },
    version: 1,
  };
}

function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
