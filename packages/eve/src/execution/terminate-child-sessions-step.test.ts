import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#subagents/handles/store.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { SESSION_TASKS_STATE_KEY, type SessionTaskIndexEntry } from "#tasks/session-index.js";

const COMPILED_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
};

const {
  cancelOwnedTaskMock,
  cancelRunMock,
  deserializeContextMock,
  getWorldMock,
  getDynamicSubagentSelectionMock,
  hydrateDurableSessionMock,
  resetRemoteAgentSessionMock,
  resolveRemoteAgentForActionMock,
  resolveRemoteAgentStreamHeadersMock,
  resolveEffectiveAgentRuntimeMock,
} = vi.hoisted(() => ({
  cancelOwnedTaskMock: vi.fn(),
  cancelRunMock: vi.fn(),
  deserializeContextMock: vi.fn(),
  getWorldMock: vi.fn(),
  getDynamicSubagentSelectionMock: vi.fn(),
  hydrateDurableSessionMock: vi.fn(),
  resetRemoteAgentSessionMock: vi.fn(),
  resolveRemoteAgentForActionMock: vi.fn(),
  resolveRemoteAgentStreamHeadersMock: vi.fn(),
  resolveEffectiveAgentRuntimeMock: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: deserializeContextMock,
}));
vi.mock("#context/dynamic-subagent-lifecycle.js", () => ({
  getDynamicSubagentSelection: getDynamicSubagentSelectionMock,
}));
vi.mock("#execution/effective-agent-config.js", () => ({
  resolveEffectiveAgentRuntime: resolveEffectiveAgentRuntimeMock,
}));
vi.mock("#execution/session.js", () => ({
  hydrateDurableSession: hydrateDurableSessionMock,
}));
vi.mock("#subagents/remote-dispatch.js", () => ({
  resetRemoteAgentSession: resetRemoteAgentSessionMock,
  resolveRemoteAgentForAction: resolveRemoteAgentForActionMock,
  resolveRemoteAgentStreamHeaders: resolveRemoteAgentStreamHeadersMock,
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
    deserializeContextMock.mockResolvedValue({ require: vi.fn().mockReturnValue(COMPILED_BUNDLE) });
    getWorldMock.mockReset();
    getWorldMock.mockResolvedValue("world");
    getDynamicSubagentSelectionMock.mockReset();
    getDynamicSubagentSelectionMock.mockReturnValue(undefined);
    hydrateDurableSessionMock.mockReset();
    hydrateDurableSessionMock.mockReturnValue("runtime-session");
    resetRemoteAgentSessionMock.mockReset();
    resetRemoteAgentSessionMock.mockResolvedValue({ ok: true, status: "no_active_session" });
    resolveRemoteAgentForActionMock.mockReset();
    resolveRemoteAgentForActionMock.mockReturnValue({
      description: "Research remotely",
      kind: "remote",
      name: "research",
      nodeId: "subagents/research",
      path: "/eve/v1/session",
      url: "https://remote.example.com",
    });
    resolveRemoteAgentStreamHeadersMock.mockReset();
    resolveRemoteAgentStreamHeadersMock.mockResolvedValue({ authorization: "Bearer fresh" });
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

  it("resets remote children and terminates local children", async () => {
    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({ id: "ag_remote:1", kind: "agent/remote", sessionId: "session-remote" }),
        runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" }),
      ]),
    });

    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-local", {
      cancelReason: "Parent session ended",
    });
    expect(resolveRemoteAgentForActionMock).toHaveBeenCalledWith({
      dynamicRemoteAgent: undefined,
      nodeId: "subagents/research",
      registry: COMPILED_BUNDLE.subagentRegistry.subagentsByNodeId,
      remoteAgentName: "research",
    });
    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      remote: expect.objectContaining({ url: "https://remote.example.com" }),
      sessionId: "session-remote",
    });
  });

  it("does not send current credentials to a legacy child's previous URL", async () => {
    resolveRemoteAgentForActionMock.mockReturnValue({
      name: "research",
      url: "https://new-remote.example.com",
    });

    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({ id: "ag_remote:1", kind: "agent/remote", sessionId: "session-remote" }),
      ]),
    });

    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      headers: {},
      remote: { name: "research", url: "https://remote.example.com" },
      sessionId: "session-remote",
    });
  });

  it("uses fresh current credentials when a legacy child's URL still matches", async () => {
    const auth = vi.fn();
    const headers = vi.fn();
    resolveRemoteAgentForActionMock.mockReturnValue({
      auth,
      headers,
      name: "research",
      url: "https://remote.example.com",
    });

    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({ id: "ag_remote:1", kind: "agent/remote", sessionId: "session-remote" }),
      ]),
    });

    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      remote: expect.objectContaining({
        auth,
        headers,
        name: "research",
        url: "https://remote.example.com",
      }),
      sessionId: "session-remote",
    });
  });

  it("resets a remote child with its creation-time credential resolver", async () => {
    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({
          credentialResolver: { resolverId: "dynamic-credentials-step" },
          id: "ag_remote:1",
          kind: "agent/remote",
          sessionId: "session-remote",
        }),
      ]),
    });

    expect(getDynamicSubagentSelectionMock).not.toHaveBeenCalled();
    expect(resolveRemoteAgentForActionMock).not.toHaveBeenCalled();
    expect(resolveRemoteAgentStreamHeadersMock).toHaveBeenCalledWith({
      bundle: COMPILED_BUNDLE,
      name: "research",
      resolverId: "dynamic-credentials-step",
      url: "https://remote.example.com",
    });
    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      headers: { authorization: "Bearer fresh" },
      remote: { name: "research", url: "https://remote.example.com" },
      sessionId: "session-remote",
    });
  });

  it("does not invent credentials for a child created without a resolver", async () => {
    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({
          credentialResolver: {},
          id: "ag_remote:1",
          kind: "agent/remote",
          sessionId: "session-remote",
        }),
      ]),
    });

    expect(getDynamicSubagentSelectionMock).not.toHaveBeenCalled();
    expect(resolveRemoteAgentStreamHeadersMock).not.toHaveBeenCalled();
    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      headers: {},
      remote: { name: "research", url: "https://remote.example.com" },
      sessionId: "session-remote",
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
        "[eve:execution.cancel-indexed-session-tasks] failed to cancel indexed task",
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

function makeAddress(
  kind: AddressKind,
  sessionId: string,
  credentialResolver?: { readonly resolverId?: string },
) {
  return kind === "agent/remote"
    ? {
        callbackBaseUrl: "https://parent.example.com",
        credentialResolver,
        kind,
        sessionId,
        url: "https://remote.example.com",
      }
    : { continuationToken: `${sessionId}:token`, kind, sessionId };
}

function runningHandle(input: {
  readonly credentialResolver?: { readonly resolverId?: string };
  readonly id: string;
  readonly kind: AddressKind;
  readonly sessionId: string;
}): AgentHandle {
  return {
    address: makeAddress(input.kind, input.sessionId, input.credentialResolver),
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
  readonly credentialResolver?: { readonly resolverId?: string };
  readonly id: string;
  readonly kind: AddressKind;
  readonly sessionId: string;
}): AgentHandle {
  return {
    address: makeAddress(input.kind, input.sessionId, input.credentialResolver),
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
      kind: "tool",
      name: "research",
    },
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
            : {
                [AGENT_HANDLES_STATE_KEY]: { handles },
                [SESSION_TASKS_STATE_KEY]: { tasks, version: 2 },
              },
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
