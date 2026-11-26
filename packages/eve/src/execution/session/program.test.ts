import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialSessionValues } from "#execution/initial-session-values.js";
import { finalizeSession } from "#execution/session/finalization.js";
import {
  runPreparedSession,
  type SessionBoot,
  type SessionHost,
} from "#execution/session/program.js";
import {
  createSessionInbox,
  type InboxHook,
  type SessionInboxHandle,
} from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";

vi.mock("./finalization.js", () => ({
  finalizeSession: vi.fn(async () => ({ output: "" })),
}));

vi.mock("#subagents/parent-notification.js", () => ({
  notifyCancelledTaskCallerStep: vi.fn(),
  notifyTurnCallerStep: vi.fn(),
  resolveInitialTurnCallerStep: vi.fn(),
}));

function makeInbox(): SessionInboxHandle {
  const hook = (token: string): InboxHook => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<never>(() => {});
    },
    token,
  });
  return createSessionInbox({
    confirm: async () => {},
    dispose: async () => {},
    isTakenOver: () => false,
    open: (token) => hook(token),
    ownerRunId: () => "owner-1",
  });
}

function makeBoot(timeout: SessionTimeoutControl): SessionBoot {
  const initial = createInitialSessionValues({
    continuationToken: "http:session-1",
    sessionId: "session-1",
  });
  return {
    admittedDeliveryKeys: [],
    anchor: { kind: "self" },
    caller: undefined,
    deploymentId: "dpl_1",
    history: initial.history,
    initialTurnControl: {
      cancellation: new AbortController(),
      steering: new AbortController(),
    },
    serializedContext: {},
    sessionId: "session-1",
    sessionState: initial.state,
    sessionTimeoutControl: timeout,
    sessionTimeoutMs: 60_000,
    sessionWritable: new WritableStream(),
    start: {
      input: { kind: "deliver", payloads: [{ message: "hello" }] },
      kind: "turn",
    },
  };
}

function makeHost(action: "done" | "parked"): SessionHost {
  return {
    applyRunMessages: vi.fn(async () => ({ cancelled: false, stateDelta: {} })),
    dispatchRuns: vi.fn(async () => ({
      pending: { executing: [], refused: [], started: [] },
      results: [],
      stateDelta: {},
    })),
    runTurnStep: vi.fn(async () =>
      action === "done"
        ? { action: "done" as const, output: "ok", stateDelta: {} }
        : { action: "parked" as const, settled: { output: "ok" }, stateDelta: {} },
    ),
    until: () => new Promise<never>(() => {}),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("runPreparedSession deferred session timeout", () => {
  it("skips starting sessionTimeout when a turn-started session completes immediately", async () => {
    const start = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const timeout: SessionTimeoutControl = {
      dispose,
      getDeadline: () => new Date(),
      handleTimerElapsed: async () => "expired",
      recordActivity: vi.fn(),
      start,
    };

    await runPreparedSession(makeBoot(timeout), makeInbox(), makeHost("done"));

    expect(start).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails the session when deferred sessionTimeout.start() rejects after parking", async () => {
    const failure = new Error("timeout workflow failed to start");
    const start = vi.fn(async () => {
      throw failure;
    });
    const dispose = vi.fn(async () => {});
    const timeout: SessionTimeoutControl = {
      dispose,
      getDeadline: () => new Date(),
      handleTimerElapsed: async () => "expired",
      recordActivity: vi.fn(),
      start,
    };

    await expect(
      runPreparedSession(makeBoot(timeout), makeInbox(), makeHost("parked")),
    ).rejects.toThrow("Agent workflow failed.");

    expect(start).toHaveBeenCalledOnce();
    expect(finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure, kind: "failed" }),
      expect.anything(),
    );
  });

  it("recovers directTaskOwner from serializedContext when a successor boots parked", async () => {
    const timeout: SessionTimeoutControl = {
      dispose: vi.fn(async () => {}),
      getDeadline: () => new Date(),
      handleTimerElapsed: async () => "expired",
      recordActivity: vi.fn(),
      start: vi.fn(async () => {}),
    };
    const directTask = {
      sequence: 1,
      stepIndex: 0,
      taskId: "agent-abc123",
      toolName: "agent",
      turnId: "turn_0",
    };
    const boot: SessionBoot = {
      ...makeBoot(timeout),
      caller: undefined,
      serializedContext: {
        "eve.channel": {
          kind: "subagent",
          state: {
            callId: "call-1",
            directTask,
            parentContinuationToken: "eve:inbox:v1:eve:session:parent:inbox",
            parentSessionId: "parent",
            subagentName: "agent",
          },
        },
      },
      start: { kind: "parked" },
    };
    const inbox = createSessionInbox({
      confirm: async () => {},
      dispose: async () => {},
      isTakenOver: () => false,
      open: (token) => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "session-timeout", ownerRunId: "owner-1" };
        },
        token,
      }),
      ownerRunId: () => "owner-1",
    });
    await inbox.claimSessionHook("eve:session:session-1:inbox");

    await runPreparedSession(boot, inbox, makeHost("parked"));

    expect(finalizeSession).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "expired" }),
      expect.objectContaining({
        directTaskOwner: {
          callId: "call-1",
          directTask,
          replyTo: { kind: "hook", token: "eve:inbox:v1:eve:session:parent:inbox" },
          subagentName: "agent",
        },
      }),
    );
  });
});
