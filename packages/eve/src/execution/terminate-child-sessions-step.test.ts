import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskRecord } from "#tasks/record.js";

const COMPILED_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
};

const {
  cancelRunMock,
  deserializeContextMock,
  getWorldMock,
  resetRemoteAgentSessionMock,
  resolveRemoteAgentStreamHeadersMock,
  resolveSessionOwnerRunIdMock,
} = vi.hoisted(() => ({
  resolveSessionOwnerRunIdMock: vi.fn(),
  cancelRunMock: vi.fn(),
  deserializeContextMock: vi.fn(),
  getWorldMock: vi.fn(),
  resetRemoteAgentSessionMock: vi.fn(),
  resolveRemoteAgentStreamHeadersMock: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: deserializeContextMock,
}));
vi.mock("#subagents/remote-dispatch.js", () => ({
  resetRemoteAgentSession: resetRemoteAgentSessionMock,
  resolveRemoteAgentStreamHeaders: resolveRemoteAgentStreamHeadersMock,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: cancelRunMock,
  getWorld: getWorldMock,
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  resolveSessionOwnerRunId: resolveSessionOwnerRunIdMock,
}));

const remoteChild = {
  callbackBaseUrl: "https://parent.example.com",
  kind: "remote" as const,
  sessionId: "session-remote",
  url: "https://remote.example.com",
};

describe("terminateChildSessionsStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cancelRunMock.mockResolvedValue(undefined);
    deserializeContextMock.mockResolvedValue({ require: vi.fn().mockReturnValue(COMPILED_BUNDLE) });
    getWorldMock.mockResolvedValue("world");
    resetRemoteAgentSessionMock.mockResolvedValue({ ok: true, status: "no_active_session" });
    resolveRemoteAgentStreamHeadersMock.mockResolvedValue({ authorization: "Bearer fresh" });
    resolveSessionOwnerRunIdMock.mockImplementation(async (sessionId: string) => sessionId);
  });

  it("stops the run that owns a local child's inbox after the child handed off", async () => {
    resolveSessionOwnerRunIdMock.mockResolvedValue("session-idle-successor");

    await terminateChildSessionsStep({
      sessionState: makeSessionState([
        localRecord({ id: "research-bbbbbb", sessionId: "session-idle", status: "completed" }),
      ]),
    });

    expect(resolveSessionOwnerRunIdMock).toHaveBeenCalledExactlyOnceWith("session-idle");
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-idle-successor", {
      cancelReason: "Parent session ended",
    });
  });

  it("stops working and idle local children", async () => {
    await terminateChildSessionsStep({
      sessionState: makeSessionState([
        localRecord({ id: "research-aaaaaa", sessionId: "session-working" }),
        localRecord({ id: "research-bbbbbb", sessionId: "session-idle", status: "completed" }),
      ]),
    });

    expect(cancelRunMock).toHaveBeenCalledTimes(2);
    expect(cancelRunMock).toHaveBeenNthCalledWith(1, "world", "session-working", {
      cancelReason: "Parent session ended",
    });
    expect(cancelRunMock).toHaveBeenNthCalledWith(2, "world", "session-idle", {
      cancelReason: "Parent session ended",
    });
    expect(deserializeContextMock).not.toHaveBeenCalled();
  });

  it("resets a remote child with its creation-time credential resolver", async () => {
    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([
        createTaskRecord({
          child: { ...remoteChild, credentialResolver: "dynamic-credentials-step" },
          status: "completed",
        }),
        localRecord({ id: "research-aaaaaa", sessionId: "session-local" }),
      ]),
    });

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
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-local", {
      cancelReason: "Parent session ended",
    });
  });

  it("does not invent credentials for a remote child created without a resolver", async () => {
    await terminateChildSessionsStep({
      serializedContext: { context: "serialized" },
      sessionState: makeSessionState([createTaskRecord({ child: remoteChild })]),
    });

    expect(resolveRemoteAgentStreamHeadersMock).not.toHaveBeenCalled();
    expect(resetRemoteAgentSessionMock).toHaveBeenCalledWith({
      headers: {},
      remote: { name: "research", url: "https://remote.example.com" },
      sessionId: "session-remote",
    });
  });

  it("requires serialized context to retire a remote child", async () => {
    await expect(
      terminateChildSessionsStep({
        sessionState: makeSessionState([createTaskRecord({ child: remoteChild })]),
      }),
    ).rejects.toThrow("Child finalization requires serialized runtime context.");
  });

  it("cancels the owner's task timer", async () => {
    const sessionState = makeSessionState([]);
    await terminateChildSessionsStep({
      sessionState: {
        ...sessionState,
        snapshot: {
          session: {
            ...sessionState.snapshot.session,
            state: {
              "eve.taskTimer": {
                ownerRunId: "owner-1",
                runId: "timer-1",
                wakeAt: "2026-09-24T14:00:00.000Z",
              },
            },
          },
        },
      },
    });

    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "timer-1", {
      cancelReason: "Parent session ended",
    });
  });

  it("skips a task whose child never reported its address", async () => {
    await terminateChildSessionsStep({
      sessionState: makeSessionState([
        createTaskRecord({ id: "research-aaaaaa" }),
        localRecord({ id: "research-bbbbbb", sessionId: "session-started" }),
      ]),
    });

    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith("world", "session-started", {
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
            localRecord({ id: "research-aaaaaa", sessionId: "session-1" }),
            localRecord({ id: "research-bbbbbb", sessionId: "session-2" }),
          ]),
        }),
      ).resolves.toBeUndefined();

      expect(cancelRunMock).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        "[eve:execution.terminate-child-sessions] failed to terminate child session",
        expect.objectContaining({ childKind: "local", taskId: "research-aaaaaa" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function localRecord(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly status?: TaskRecord["status"];
}): TaskRecord {
  return createTaskRecord({
    child: {
      continuationToken: `${input.sessionId}:token`,
      kind: "local",
      sessionId: input.sessionId,
    },
    id: input.id,
    status: input.status ?? "working",
  });
}

function makeSessionState(records: readonly TaskRecord[]): DurableSessionState {
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
        state: taskTableState(records),
      },
    },
    version: 1,
  };
}
