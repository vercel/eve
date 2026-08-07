import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_HANDLES_STATE_KEY, type AgentHandle } from "#harness/handles/store.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";

const { cancelRunMock, getWorldMock } = vi.hoisted(() => ({
  cancelRunMock: vi.fn(),
  getWorldMock: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: cancelRunMock,
  getWorld: getWorldMock,
}));

describe("terminateChildSessionsStep", () => {
  beforeEach(() => {
    cancelRunMock.mockReset();
    cancelRunMock.mockResolvedValue(undefined);
    getWorldMock.mockReset();
    getWorldMock.mockResolvedValue("world");
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

function makeSessionState(handles: readonly AgentHandle[]): DurableSessionState {
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
        state: {
          [AGENT_HANDLES_STATE_KEY]: { handles },
        },
      },
      version: 1,
    },
    version: 1,
  };
}
