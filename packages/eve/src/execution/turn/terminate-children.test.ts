import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#subagents/handles/store.js";
import type { DurableSessionState } from "#execution/session/state.js";
import { terminateChildSessions } from "#execution/turn/terminate-children.js";
import { SESSION_TASKS_STATE_KEY, type SessionTaskIndexEntry } from "#tasks/session-index.js";

const COMPILED_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
};

const {
  cancelOwnedTaskMock,
  dispatchSessionCommandMock,
  deserializeContextMock,
  waitForTurnReceiptMock,
  getDynamicSubagentSelectionMock,
  hydrateDurableSessionMock,
  resetRemoteAgentSessionMock,
  resolveRemoteAgentForActionMock,
  resolveRemoteAgentStreamHeadersMock,
  resolveEffectiveAgentRuntimeMock,
} = vi.hoisted(() => ({
  cancelOwnedTaskMock: vi.fn(),
  dispatchSessionCommandMock: vi.fn(),
  deserializeContextMock: vi.fn(),
  waitForTurnReceiptMock: vi.fn(),
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
vi.mock("#execution/tasks/control.js", () => ({
  cancelOwnedTask: cancelOwnedTaskMock,
}));
vi.mock("#execution/session/ingress.js", () => ({
  dispatchSessionCommand: dispatchSessionCommandMock,
}));
vi.mock("#execution/turn/admission.js", () => ({ waitForTurnReceipt: waitForTurnReceiptMock }));

describe("terminateChildSessions", () => {
  beforeEach(() => {
    cancelOwnedTaskMock.mockReset();
    cancelOwnedTaskMock.mockResolvedValue(undefined);
    dispatchSessionCommandMock.mockReset();
    dispatchSessionCommandMock.mockResolvedValue({ run: { runId: "reset-candidate" } });
    deserializeContextMock.mockReset();
    deserializeContextMock.mockResolvedValue({ require: vi.fn().mockReturnValue(COMPILED_BUNDLE) });
    waitForTurnReceiptMock.mockReset();
    waitForTurnReceiptMock.mockResolvedValue({ terminal: true, deliveries: {} });
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

    await terminateChildSessions({
      sessionState: makeSessionState(handles),
    });

    expect(dispatchSessionCommandMock).toHaveBeenCalledTimes(2);
    expect(dispatchSessionCommandMock).toHaveBeenNthCalledWith(
      1,
      "session-local",
      { kind: "reset" },
      "parent-ended:parent-session:session-local",
    );
    expect(dispatchSessionCommandMock).toHaveBeenNthCalledWith(
      2,
      "session-self",
      { kind: "reset" },
      "parent-ended:parent-session:session-self",
    );
  });

  it("resets remote children and terminates local children", async () => {
    await terminateChildSessions({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        parkedHandle({ id: "ag_remote:1", kind: "agent/remote", sessionId: "session-remote" }),
        runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" }),
      ]),
    });

    expect(dispatchSessionCommandMock).toHaveBeenCalledExactlyOnceWith(
      "session-local",
      { kind: "reset" },
      "parent-ended:parent-session:session-local",
    );
    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      headers: {},
      remote: expect.objectContaining({ url: "https://remote.example.com" }),
      sessionId: "session-remote",
    });
  });

  it("resets a remote child with its creation-time credential resolver", async () => {
    await terminateChildSessions({
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
    await terminateChildSessions({
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
    await terminateChildSessions({
      sessionState: makeSessionState([
        startingHandle({ id: "ag_local:starting", kind: "agent/local" }),
        parkedHandle({ id: "ag_self:1", kind: "agent/self", sessionId: "session-self" }),
      ]),
    });

    expect(dispatchSessionCommandMock).toHaveBeenCalledExactlyOnceWith(
      "session-self",
      { kind: "reset" },
      "parent-ended:parent-session:session-self",
    );
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
    dispatchSessionCommandMock.mockImplementation(async () => {
      order.push("child-cancelled");
      return { run: { runId: "reset-candidate" } };
    });

    const termination = terminateChildSessions({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState(
        [runningHandle({ id: "ag_local:1", kind: "agent/local", sessionId: "session-local" })],
        [indexedTask("task-1"), indexedTask("task-2")],
      ),
    });

    await vi.waitFor(() => expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(1));
    expect(dispatchSessionCommandMock).not.toHaveBeenCalled();

    firstCancellation.resolve();
    await vi.waitFor(() => expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(2));
    expect(order).toEqual(["task-1-settled"]);
    expect(dispatchSessionCommandMock).not.toHaveBeenCalled();

    secondCancellation.resolve();
    await termination;

    expect(order).toEqual(["task-1-settled", "task-2-settled", "child-cancelled"]);
    expect(dispatchSessionCommandMock).toHaveBeenCalledExactlyOnceWith(
      "session-local",
      { kind: "reset" },
      "parent-ended:parent-session:session-local",
    );
  });

  it("continues finalization after an indexed task cancellation fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    cancelOwnedTaskMock
      .mockRejectedValueOnce(new Error("task cancellation unavailable"))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(
        terminateChildSessions({
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
      ).rejects.toThrow("Child termination did not complete.");

      expect(cancelOwnedTaskMock).toHaveBeenCalledTimes(2);
      expect(dispatchSessionCommandMock).toHaveBeenCalledExactlyOnceWith(
        "session-local",
        { kind: "reset" },
        "parent-ended:parent-session:session-local",
      );
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
    dispatchSessionCommandMock
      .mockRejectedValueOnce(new Error("termination unavailable"))
      .mockResolvedValueOnce(undefined);

    try {
      await expect(
        terminateChildSessions({
          sessionState: makeSessionState([
            runningHandle({ id: "ag_child:1", kind: "agent/local", sessionId: "session-1" }),
            parkedHandle({ id: "ag_child:2", kind: "agent/self", sessionId: "session-2" }),
          ]),
        }),
      ).rejects.toThrow("Child termination did not complete.");

      expect(dispatchSessionCommandMock).toHaveBeenCalledTimes(2);
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
    },
  };
}

function createDeferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
