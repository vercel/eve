import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableSessionState } from "#execution/durable-session-store.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskRecord } from "#tasks/record.js";

const COMPILED_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
};

const {
  armChildHardStopMock,
  cancelRunMock,
  cancelWorkflowToolRunMock,
  deserializeContextMock,
  getWorldMock,
  requestWorkflowSessionEndMock,
  resetRemoteAgentSessionMock,
  resolveRemoteAgentStreamHeadersMock,
} = vi.hoisted(() => ({
  armChildHardStopMock: vi.fn(),
  cancelRunMock: vi.fn(),
  cancelWorkflowToolRunMock: vi.fn(),
  deserializeContextMock: vi.fn(),
  getWorldMock: vi.fn(),
  requestWorkflowSessionEndMock: vi.fn(),
  resetRemoteAgentSessionMock: vi.fn(),
  resolveRemoteAgentStreamHeadersMock: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: deserializeContextMock,
}));
vi.mock("#subagents/remote/dispatch.js", () => ({
  resetRemoteAgentSession: resetRemoteAgentSessionMock,
  resolveRemoteAgentStreamHeaders: resolveRemoteAgentStreamHeadersMock,
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  cancelRun: cancelRunMock,
  getWorld: getWorldMock,
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  requestWorkflowSessionEnd: requestWorkflowSessionEndMock,
}));
vi.mock("#execution/tools/workflow/cancel.js", () => ({
  cancelWorkflowToolRun: cancelWorkflowToolRunMock,
}));
vi.mock("#tasks/timer-steps.js", async (importOriginal) => ({
  ...(await importOriginal()),
  armChildHardStop: armChildHardStopMock,
}));

const NOW = "2026-09-24T14:00:00.000Z";

const remoteChild = {
  callbackBaseUrl: "https://parent.example.com",
  kind: "remote" as const,
  sessionId: "session-remote",
  url: "https://remote.example.com",
};

describe("terminateChildSessionsStep", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] });
    armChildHardStopMock.mockResolvedValue(undefined);
    cancelRunMock.mockResolvedValue(undefined);
    cancelWorkflowToolRunMock.mockResolvedValue(undefined);
    deserializeContextMock.mockResolvedValue({ require: vi.fn().mockReturnValue(COMPILED_BUNDLE) });
    getWorldMock.mockResolvedValue("world");
    requestWorkflowSessionEndMock.mockResolvedValue(undefined);
    resetRemoteAgentSessionMock.mockResolvedValue({ ok: true, status: "no_active_session" });
    resolveRemoteAgentStreamHeadersMock.mockResolvedValue({ authorization: "Bearer fresh" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks working and idle local children to end, and hard-stops them only after 30 seconds", async () => {
    const working = localRecord({ id: "research-aaaaaa", sessionId: "session-working" });
    const idle = localRecord({
      id: "research-bbbbbb",
      sessionId: "session-idle",
      status: "completed",
    });

    await terminateChildSessionsStep({ sessionState: makeSessionState([working, idle]) });

    // Each child ends its own session, so it stops its own tasks and children.
    expect(requestWorkflowSessionEndMock.mock.calls).toEqual([
      [{ reason: "Parent session ended", sessionId: "session-working" }],
      [{ reason: "Parent session ended", sessionId: "session-idle" }],
    ]);
    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(armChildHardStopMock).toHaveBeenCalledExactlyOnceWith({
      ownerSessionId: "parent-session",
      targets: [working.child, idle.child],
      wakeAt: "2026-09-24T14:00:30.000Z",
    });
    expect(deserializeContextMock).not.toHaveBeenCalled();
  });

  it("cancels a working workflow run and hard-stops each run that still owes a stop", async () => {
    const working = workflowRecord({ id: "deploy-aaaaaa", runId: "run-working" });
    const cancelled = {
      ...workflowRecord({ id: "deploy-bbbbbb", runId: "run-cancelled", status: "cancelled" }),
      cancelConfirmBy: "2026-09-24T14:00:20.000Z",
      delivered: true,
    };
    const finished = {
      ...workflowRecord({ id: "deploy-cccccc", runId: "run-finished", status: "completed" }),
      delivered: true,
    };

    await terminateChildSessionsStep({
      sessionState: makeSessionState([working, cancelled, finished]),
    });

    expect(cancelWorkflowToolRunMock).toHaveBeenCalledExactlyOnceWith(
      { hookToken: "run-working:command", runId: "run-working" },
      "Parent session ended",
    );
    // A run gets its full cleanup window plus a margin, as for a cancel.
    expect(armChildHardStopMock).toHaveBeenCalledExactlyOnceWith({
      ownerSessionId: "parent-session",
      targets: [working.child, cancelled.child],
      wakeAt: "2026-09-24T14:00:35.000Z",
    });
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
    expect(requestWorkflowSessionEndMock).toHaveBeenCalledExactlyOnceWith({
      reason: "Parent session ended",
      sessionId: "session-local",
    });
    // The remote child stops where it runs; only the local one is hard-stopped.
    expect(armChildHardStopMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ targets: [expect.objectContaining({ kind: "local" })] }),
    );
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
    expect(armChildHardStopMock).not.toHaveBeenCalled();
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

    expect(requestWorkflowSessionEndMock).toHaveBeenCalledExactlyOnceWith({
      reason: "Parent session ended",
      sessionId: "session-started",
    });
  });

  it("keeps ending children after one request fails, and still arms the hard stop", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    requestWorkflowSessionEndMock
      .mockRejectedValueOnce(new Error("inbox unavailable"))
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

      expect(requestWorkflowSessionEndMock).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        "[eve:execution.terminate-child-sessions] failed to end a child",
        expect.objectContaining({ childKind: "local", taskId: "research-aaaaaa" }),
      );
      expect(armChildHardStopMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          targets: [
            expect.objectContaining({ sessionId: "session-1" }),
            expect.objectContaining({ sessionId: "session-2" }),
          ],
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function workflowRecord(input: {
  readonly id: string;
  readonly runId: string;
  readonly status?: TaskRecord["status"];
}): TaskRecord {
  return createTaskRecord({
    child: { commandToken: `${input.runId}:command`, kind: "workflow", runId: input.runId },
    id: input.id,
    kind: "workflow",
    name: "deploy",
    status: input.status ?? "working",
  });
}

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
