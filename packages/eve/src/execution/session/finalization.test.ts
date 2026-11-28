import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeSession } from "#execution/session/finalization.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { writeTaskTable } from "#execution/tasks/table.js";
import {
  reportChildSessionTeardownFailureStep,
  terminateChildSessionsStep,
} from "#execution/terminate-child-sessions-step.js";
import { takeSessionUsageDelta } from "#harness/session-usage.js";
import { withSessionUsage } from "#internal/testing/session-usage.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { HarnessSession } from "#harness/types.js";
import { closeSessionStreamStep } from "#execution/close-session-stream-step.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import {
  notifyCancelledTaskCallerStep,
  notifyTurnCallerStep,
} from "#subagents/parent-notification.js";
import {
  reportSessionSubscriptionRetireFailureStep,
  retireSessionSubscriptionsStep,
} from "#runtime/subscriptions/steps.js";
import {
  endSessionSandboxStep,
  reportSessionSandboxCleanupFailureStep,
} from "#execution/session/end-sandbox-step.js";

vi.mock("#execution/close-session-stream-step.js", () => ({
  closeSessionStreamStep: vi.fn(),
}));
vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  reportChildSessionTeardownFailureStep: vi.fn(async () => {}),
  terminateChildSessionsStep: vi.fn(async () => {}),
}));
vi.mock("#execution/session/end-sandbox-step.js", () => ({
  endSessionSandboxStep: vi.fn(),
  reportSessionSandboxCleanupFailureStep: vi.fn(async () => {}),
}));
vi.mock("#runtime/subscriptions/steps.js", () => ({
  reportSessionSubscriptionRetireFailureStep: vi.fn(async () => {}),
  retireSessionSubscriptionsStep: vi.fn(async () => {}),
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-failure-step.js", () => ({
  emitTerminalSessionFailureStep: vi.fn(),
}));
vi.mock("#subagents/parent-notification.js", () => ({
  notifyCancelledTaskCallerStep: vi.fn(),
  notifyTurnCallerStep: vi.fn(),
}));

function withUsage(session: HarnessSession, inputTokens: number): HarnessSession {
  return withSessionUsage(session, { inputTokens });
}

function baseSession(): HarnessSession {
  return {
    compaction: {},
    continuationToken: "detector",
    history: [],
    sessionId: "detector",
  };
}

function sessionWithUnreportedUsage() {
  const session = baseSession();
  const previouslySettled = takeSessionUsageDelta(withUsage(session, 100)).session;
  return createDurableSessionState({ session: withUsage(previouslySettled, 250) });
}

function subagentSession() {
  return createDurableSessionState({ session: { ...baseSession(), rootSessionId: "root" } });
}

function sessionWithTaskRun() {
  return createDurableSessionState({
    session: writeTaskTable(baseSession(), {
      tasks: [
        {
          calls: [{ callId: "call-1", turnId: "turn_0" }],
          id: "task-1",
          kind: "agent",
          name: "researcher",
          resumable: false,
          results: [],
          run: { hookToken: "hook-1", runId: "run-1", started: true },
        },
      ],
    }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("session finalization", () => {
  it.each([
    { outcome: { kind: "expired" as const }, reason: "expired" },
    { outcome: { cause: { hook: "finish-job" }, kind: "ended" as const }, reason: "completed" },
    { outcome: { kind: "failed" as const, error: new Error("failed") }, reason: "failed" },
    {
      outcome: {
        kind: "done" as const,
        action: { kind: "done" as const, output: "done" },
      },
      reason: "completed",
    },
  ])("ends the sandbox when the session is $reason", async ({ outcome, reason }) => {
    const sessionState = sessionWithUnreportedUsage();
    await finalizeSession(outcome, {
      caller: undefined,
      cursor: { serializedContext: { key: "value" }, sessionState },
      sessionWritable: new WritableStream(),
    });

    expect(endSessionSandboxStep).toHaveBeenCalledExactlyOnceWith({
      reason,
      serializedContext: { key: "value" },
      sessionState,
    });
    if (outcome.kind === "ended") {
      expect(emitTerminalSessionCompletionStep).toHaveBeenCalledWith(
        expect.objectContaining({ cause: { hook: "finish-job" } }),
      );
    }
  });

  it.each([
    { kind: "expired" as const },
    { kind: "failed" as const, error: new Error("failed") },
    { kind: "ended" as const },
    { kind: "done" as const, action: { kind: "done" as const, output: "done" } },
  ])("retires the session's subscriptions when the session is $kind", async (outcome) => {
    await finalizeSession(outcome, {
      caller: undefined,
      cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
      sessionWritable: new WritableStream(),
    });

    expect(retireSessionSubscriptionsStep).toHaveBeenCalledExactlyOnceWith({
      sessionId: "detector",
    });
  });

  it("skips retiring for a subagent session, which cannot subscribe", async () => {
    await finalizeSession(
      { kind: "expired" },
      {
        caller: {
          callId: "delegate",
          subagentName: "detector",
          replyTo: { kind: "hook", token: "parent" },
        },
        cursor: { serializedContext: {}, sessionState: subagentSession() },
        sessionWritable: new WritableStream(),
      },
    );
    expect(retireSessionSubscriptionsStep).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "expired" as const },
    { kind: "failed" as const, error: new Error("failed on the first turn") },
  ])("retires a callback-backed root session's subscriptions when it is $kind", async (outcome) => {
    await finalizeSession(outcome, {
      caller: {
        callId: "delegate",
        subagentName: "detector",
        replyTo: { kind: "callback", token: "token", url: "https://parent.example/callback" },
      },
      cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
      sessionWritable: new WritableStream(),
    });
    expect(retireSessionSubscriptionsStep).toHaveBeenCalledExactlyOnceWith({
      sessionId: "detector",
    });
  });

  it("takes the session id from the serialized context when no session state was kept", async () => {
    await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: { "eve.sessionId": "from-context" }, sessionState: undefined },
        sessionWritable: new WritableStream(),
      },
    );

    expect(retireSessionSubscriptionsStep).toHaveBeenCalledExactlyOnceWith({
      sessionId: "from-context",
    });
  });

  it("preserves the terminal outcome when retiring the subscriptions fails", async () => {
    vi.mocked(retireSessionSubscriptionsStep).mockRejectedValueOnce(new Error("world down"));

    await expect(
      finalizeSession(
        { kind: "expired" },
        {
          caller: undefined,
          cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
          sessionWritable: new WritableStream(),
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(reportSessionSubscriptionRetireFailureStep).toHaveBeenCalledOnce();
    expect(emitTerminalSessionCompletionStep).toHaveBeenCalledOnce();
  });

  it("preserves the terminal outcome when sandbox cleanup fails", async () => {
    vi.mocked(endSessionSandboxStep).mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(
      finalizeSession(
        { kind: "expired" },
        {
          caller: undefined,
          cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
          sessionWritable: new WritableStream(),
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(reportSessionSandboxCleanupFailureStep).toHaveBeenCalledOnce();
    expect(emitTerminalSessionCompletionStep).toHaveBeenCalledOnce();
  });
});

describe("session finalization with an unsettled caller", () => {
  it.each([
    { kind: "expired" as const },
    { kind: "failed" as const, error: new Error("Owner failed") },
  ])(
    "reports terminal failure and only unreported usage when the owner is $kind",
    async (outcome) => {
      const caller = {
        callId: "delegate",
        subagentName: "detector",
        replyTo: { kind: "hook" as const, token: "parent" },
      };
      const result = await finalizeSession(outcome, {
        caller,
        cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
        sessionWritable: new WritableStream(),
      });
      expect(result).toMatchObject({
        isError: true,
        usage: { inputTokens: 250 },
        usageDelta: { inputTokens: 150 },
      });
      expect(result.output).not.toBe("");
      expect(retireSessionSubscriptionsStep).toHaveBeenCalledExactlyOnceWith({
        sessionId: "detector",
      });
      expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
        caller,
        lifecycle: "terminal",
        sessionId: "detector",
        settled: {
          isError: true,
          output: result.output,
          usage: expect.objectContaining({ inputTokens: 150 }),
        },
      });
    },
  );

  it.each([
    { kind: "expired" as const, step: emitTerminalSessionCompletionStep },
    {
      kind: "failed" as const,
      error: new Error("Owner failed"),
      step: emitTerminalSessionFailureStep,
    },
  ])("ends a $kind session with its usage on the terminal event", async ({ step, ...outcome }) => {
    await finalizeSession(outcome, {
      caller: undefined,
      cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
      sessionWritable: new WritableStream(),
    });

    expect(vi.mocked(step).mock.calls[0]?.[0].usage).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: undefined,
      inputTokens: 250,
      outputTokens: 0,
    });
  });

  it("terminates child sessions when a task run is live", async () => {
    const sessionState = sessionWithTaskRun();
    await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: {}, sessionState },
        sessionWritable: new WritableStream(),
      },
    );
    expect(terminateChildSessionsStep).toHaveBeenCalledExactlyOnceWith({ sessionState });
  });

  it("reports a failed child teardown and still ends the session", async () => {
    vi.mocked(terminateChildSessionsStep).mockRejectedValueOnce(new Error("teardown failed"));
    const sessionState = sessionWithTaskRun();

    await expect(
      finalizeSession(
        { kind: "expired" },
        {
          caller: undefined,
          cursor: { serializedContext: {}, sessionState },
          sessionWritable: new WritableStream(),
        },
      ),
    ).resolves.toMatchObject({ isError: false });
    expect(reportChildSessionTeardownFailureStep).toHaveBeenCalledExactlyOnceWith({
      error: expect.objectContaining({ message: "teardown failed" }),
      parentSessionId: sessionState.sessionId,
    });
    expect(emitTerminalSessionCompletionStep).toHaveBeenCalledOnce();
  });

  it("terminates the workflow tool calls a turn waits on when no task run is live", async () => {
    const sessionState = createDurableSessionState({
      session: registerWorkflowToolRun(baseSession(), {
        address: { hookToken: "hook-call-1", runId: "run-call-1" },
        callId: "call-1",
        origin: { stepIndex: 0, turnId: "turn_0" },
        toolName: "deploy",
      }),
    });
    await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: {}, sessionState },
        sessionWritable: new WritableStream(),
      },
    );
    expect(terminateChildSessionsStep).toHaveBeenCalledExactlyOnceWith({ sessionState });
  });

  it("does not notify again when an already settled conversation expires", async () => {
    const result = await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
        sessionWritable: new WritableStream(),
      },
    );
    expect(result).toMatchObject({ isError: false, output: "" });
    expect(notifyTurnCallerStep).not.toHaveBeenCalled();
  });

  it("notifies a delegated caller with lifecycle terminal after a hook ends a settled or cancelled turn", async () => {
    const caller = {
      callId: "delegate",
      subagentName: "detector",
      replyTo: { kind: "hook" as const, token: "parent" },
    };
    const usage = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 150, outputTokens: 10 };

    const settledResult = await finalizeSession(
      {
        cause: { hook: "finish-job" },
        kind: "ended",
        settled: { output: "Job done.", usage },
      },
      {
        caller,
        cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
        sessionWritable: new WritableStream(),
      },
    );
    expect(settledResult).toMatchObject({ isError: false, output: "Job done.", usageDelta: usage });
    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller,
      lifecycle: "terminal",
      sessionId: "detector",
      settled: { output: "Job done.", usage },
    });

    const cancelledResult = await finalizeSession(
      {
        cancelled: { usage },
        cause: { hook: "gate" },
        kind: "ended",
      },
      {
        caller,
        cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
        sessionWritable: new WritableStream(),
      },
    );
    expect(cancelledResult).toMatchObject({ isError: true, usageDelta: usage });
    expect(notifyCancelledTaskCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller,
      lifecycle: "terminal",
      sessionId: "detector",
      usage,
    });
  });

  it("finishes sandbox cleanup before notifying a done caller, then overlaps stream close with notification", async () => {
    const order: string[] = [];
    const sandbox = Promise.withResolvers<void>();
    const streamClose = Promise.withResolvers<void>();
    const notify = Promise.withResolvers<void>();
    let closeStarted = false;
    let notifyStarted = false;

    vi.mocked(endSessionSandboxStep).mockImplementation(async () => {
      order.push("sandbox:start");
      await sandbox.promise;
      order.push("sandbox:end");
    });
    vi.mocked(closeSessionStreamStep).mockImplementation(async () => {
      order.push("close:start");
      closeStarted = true;
      if (notifyStarted) {
        streamClose.resolve();
        notify.resolve();
      }
      await streamClose.promise;
    });
    vi.mocked(notifyTurnCallerStep).mockImplementation(async () => {
      order.push("notify:start");
      notifyStarted = true;
      if (closeStarted) {
        streamClose.resolve();
        notify.resolve();
      }
      await notify.promise;
    });

    const caller = {
      callId: "delegate",
      subagentName: "detector",
      replyTo: { kind: "hook" as const, token: "parent" },
    };
    const pending = finalizeSession(
      { kind: "done", action: { kind: "done", output: "finished" } },
      {
        caller,
        cursor: { serializedContext: {}, sessionState: sessionWithUnreportedUsage() },
        sessionWritable: new WritableStream(),
      },
    );

    await vi.waitFor(() => expect(order).toEqual(["sandbox:start"]));
    expect(notifyTurnCallerStep).not.toHaveBeenCalled();
    sandbox.resolve();

    await expect(pending).resolves.toMatchObject({ output: "finished" });
    expect(order.slice(0, 2)).toEqual(["sandbox:start", "sandbox:end"]);
    expect(new Set(order.slice(2))).toEqual(new Set(["close:start", "notify:start"]));
  });
});
