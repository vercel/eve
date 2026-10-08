import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeSession } from "#execution/session/finalization.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { writeTaskTable } from "#execution/tasks/table.js";
import { terminateChildSessionsStep } from "#execution/terminate-child-sessions-step.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import { registerWorkflowToolRun } from "#harness/workflow-tool-runs.js";
import type { HarnessSession } from "#harness/types.js";
import { emitTerminalSessionCompletionStep } from "#execution/terminal-session-completion-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { notifyTurnCallerStep } from "#subagents/parent-notification.js";
import {
  endSessionSandboxStep,
  reportSessionSandboxCleanupFailureStep,
} from "#execution/session/end-sandbox-step.js";

vi.mock("#execution/terminate-child-sessions-step.js", () => ({
  terminateChildSessionsStep: vi.fn(),
}));
vi.mock("#execution/session/end-sandbox-step.js", () => ({
  endSessionSandboxStep: vi.fn(),
  reportSessionSandboxCleanupFailureStep: vi.fn(async () => {}),
}));
vi.mock("#execution/terminal-session-completion-step.js", () => ({
  emitTerminalSessionCompletionStep: vi.fn(),
}));
vi.mock("#execution/terminal-session-failure-step.js", () => ({
  emitTerminalSessionFailureStep: vi.fn(),
}));
vi.mock("#subagents/parent-notification.js", () => ({
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

function baseSession(): HarnessSession {
  return {
    agent: { modelReference: { id: "unused" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
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
});
