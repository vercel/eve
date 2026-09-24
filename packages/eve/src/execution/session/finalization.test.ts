import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeSession } from "#execution/session/finalization.js";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";

vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-failure-step.js", () => ({
  emitTerminalSessionFailureStep: vi.fn(),
}));
vi.mock("#subagents/remote/callback-step.js", () => ({ fireSessionCallbackStep: vi.fn() }));

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

/** A session whose running turn has accumulated usage it has not yet reported. */
function sessionAwaitingCallerNotification() {
  const session: HarnessSession = {
    agent: { modelReference: { id: "unused" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "detector",
    history: [],
    sessionId: "detector",
  };
  const previouslySettled = takeSessionUsageDelta(withUsage(session, 100)).session;
  const parked = resolveSessionStepResult(
    { next: null, session: withUsage(previouslySettled, 250) },
    {},
    "conversation",
  );
  expect(parked).toMatchObject({ action: "park" });
  expect(parked).not.toHaveProperty("settled");
  return parked.sessionState;
}

beforeEach(() => vi.clearAllMocks());

describe("session finalization with an unsettled caller", () => {
  it.each([
    { code: { errorCode: "AGENT_SESSION_ENDED" }, outcome: { kind: "expired" as const } },
    { code: {}, outcome: { error: new Error("Owner failed"), kind: "failed" as const } },
  ])(
    "owes the caller a terminal failure and only unreported usage when the owner is $outcome.kind",
    async ({ code, outcome }) => {
      const caller = {
        callId: "delegate",
        subagentName: "detector",
        replyTo: { kind: "hook" as const, token: "parent" },
      };
      const { callerReply, result } = await finalizeSession(outcome, {
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
      // The session program sends it from its one reply site.
      expect(callerReply).toEqual({
        ...code,
        // A terminal report sorts after the parked answer at the same turn sequence.
        answer: 1,
        isError: true,
        output: result.output,
        usage: expect.objectContaining({ inputTokens: 150 }),
      });
    },
  );

  it("owes nothing when an already settled conversation expires", async () => {
    const finalized = await finalizeSession(
      { kind: "expired" },
      {
        caller: undefined,
        cursor: { serializedContext: {}, sessionState: sessionAwaitingCallerNotification() },
        mode: "conversation",
        sessionWritable: new WritableStream(),
      },
    );
    expect(finalized).toEqual({ result: expect.objectContaining({ isError: false, output: "" }) });
  });
});
