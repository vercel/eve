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
});
