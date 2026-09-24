import { describe, expect, it } from "vitest";
import { resolveSessionStepResult } from "#execution/session/turn-step-result.js";
import { setTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { HarnessSession, SettledTurn } from "#harness/types.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";

function session(): HarnessSession {
  return {
    agent: { modelReference: { id: "unused" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "detector",
    history: [],
    sessionId: "detector",
  };
}

function endTurn(session: HarnessSession, settledTurn?: SettledTurn) {
  return resolveSessionStepResult({ next: null, session, settledTurn }, {}, "conversation");
}

function withUsage(session: HarnessSession, inputTokens: number): HarnessSession {
  const totals = {
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    sawCost: false,
  };
  return setTurnUsageState(session, { ...totals, session: totals, turnId: "current-turn" });
}

describe("delegated turn completion", () => {
  it("answers the caller with the settled output and the usage accumulated since the last answer", () => {
    const previouslyAnswered = takeSessionUsageDelta(withUsage(session(), 100)).session;
    const current = withUsage(previouslyAnswered, 250);
    const settled = endTurn(current, { output: "Here is the report." });

    expect(settled).toMatchObject({
      action: "park",
      settled: { output: "Here is the report.", usage: { inputTokens: 150 } },
    });
    expect(
      takeSessionUsageDelta({ ...current, state: settled.sessionState.snapshot.session.state })
        .delta.inputTokens,
    ).toBe(0);
  });

  it("answers the caller with a final error", () => {
    expect(endTurn(session(), { isError: true, output: "Model failed" })).toMatchObject({
      action: "park",
      settled: { isError: true, output: "Model failed" },
    });
  });

  it("folds a turn's usage into the later settlement while background work is out", () => {
    const working = createTaskRecord({ kind: "workflow", mode: "background", name: "remind" });
    const current = withUsage({ ...session(), state: taskTableState([working]) }, 100);
    const settled = endTurn(current, { output: "Started the reminder." });

    expect(settled).toMatchObject({ action: "park", settled: { usage: { inputTokens: 100 } } });
    // The caller is not answered yet, so the next settlement still reports this spend.
    expect(
      takeSessionUsageDelta({ ...current, state: settled.sessionState.snapshot.session.state })
        .delta.inputTokens,
    ).toBe(100);
  });

  it("keeps usage unreported when a turn parks without settling", () => {
    const current = withUsage(session(), 100);
    const parked = endTurn(current);

    expect(parked).toMatchObject({ action: "park" });
    expect(parked).not.toHaveProperty("settled");
    expect(
      takeSessionUsageDelta({ ...current, state: parked.sessionState.snapshot.session.state }).delta
        .inputTokens,
    ).toBe(100);
  });
});
