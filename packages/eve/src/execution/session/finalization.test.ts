import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeSession } from "#execution/session/finalization.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import { notifyTurnCallerStep } from "#subagents/parent-notification.js";

vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-failure-step.js", () => ({
  emitTerminalSessionFailureStep: vi.fn(),
}));
vi.mock("#subagents/callback-step.js", () => ({ fireSessionCallbackStep: vi.fn() }));
vi.mock("#subagents/parent-notification.js", () => ({
  notifyDelegatedParentStep: vi.fn(),
  notifyTurnCallerStep: vi.fn(),
}));

function withUsage(session: HarnessSession, inputTokens: number): HarnessSession {
  const totals = {
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    sawCost: false,
  };
  return setTurnUsageState(session, { ...totals, session: totals, turnId: "current" });
}

function sessionAwaitingCallerNotification() {
  const session: HarnessSession = {
    agent: { modelReference: { id: "unused" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "detector",
    history: [],
    sessionId: "detector",
  };
  const previouslySettled = takeSessionUsageDelta(withUsage(session, 100)).session;
  const pending = registerWorkflowToolRun(withUsage(previouslySettled, 250), {
    callId: "worker",
    toolName: "worker",
    lifetime: "session",
    origin: { turnId: "current", stepIndex: 0 },
    address: { runId: "worker", hookToken: "worker" },
    task: {
      taskId: "worker",
      metadata: { kind: "subagent", name: "worker" },
      dispatchContext: { auth: { current: null, initiator: null } },
    },
  });
  const parked = resolveSessionStepResult(
    { next: null, session: pending, settledTurn: { output: "Verification is running." } },
    {},
    "conversation",
    {},
  );
  expect(parked).toMatchObject({ action: "park", completion: { notifyCaller: false } });
  return parked.sessionState;
}

beforeEach(() => vi.clearAllMocks());

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
        cursor: { serializedContext: {}, sessionState: sessionAwaitingCallerNotification() },
        mode: "conversation",
        sessionWritable: new WritableStream(),
      });
      expect(result).toMatchObject({
        isError: true,
        usage: { inputTokens: 250 },
        usageDelta: { inputTokens: 150 },
      });
      expect(result.output).not.toBe("");
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

  it("does not notify again when an already settled conversation expires", async () => {
    const result = await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: {}, sessionState: sessionAwaitingCallerNotification() },
        mode: "conversation",
        sessionWritable: new WritableStream(),
      },
    );
    expect(result).toMatchObject({ isError: false, output: "" });
    expect(notifyTurnCallerStep).not.toHaveBeenCalled();
  });
});
