import { describe, expect, it, vi } from "vitest";

import { checkSessionUsageLimit, DEFAULT_SESSION_USAGE_LIMIT } from "#harness/hitl/budget.js";
import { extractTokenUsageDelta } from "#harness/model-call/usage.js";
import type { HarnessStepResult } from "#harness/step-hooks.js";
import {
  accumulateSessionUsage,
  accumulateTurnUsage,
  addTurnUsage,
  getSessionTokenUsage,
  getSessionUsage,
  getSessionUsageWindow,
  getTurnUsageState,
  resetSessionUsageWindow,
  setTurnUsageState,
} from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";

const ZERO_SESSION_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  sawCost: false,
};

function makeSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_x" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "ct_test",
    history: [],
    sessionId: "wrun_test",
    state,
  };
}

describe("accumulateTurnUsage", () => {
  it("starts from zero when no previous state exists", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: { cacheReadTokens: 2, inputTokens: 10, outputTokens: 3 },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        cacheReadTokens: 2,
        inputTokens: 10,
        outputTokens: 3,
      },
    });
  });

  it("accumulates cache write tokens from normalized usage", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        inputTokens: 1000,
        outputTokens: 50,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      costUsd: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        costUsd: 0,
        inputTokens: 1000,
        outputTokens: 50,
        sawCost: false,
      },
    });
  });

  it("accumulates gateway cost from normalized usage", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {
        costUsd: 0.0123,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0123,
      sawCost: true,
      session: {
        ...ZERO_SESSION_USAGE,
        costUsd: 0.0123,
        sawCost: true,
      },
    });
  });

  it("sums into the previous totals when the turn id matches", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      sawCost: true,
      session: {
        cacheReadTokens: 8,
        cacheWriteTokens: 5,
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        sawCost: true,
      },
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_0",
      usage: {
        cacheReadTokens: 4,
        cacheWriteTokens: 3,
        costUsd: 0.02,
        inputTokens: 12,
        outputTokens: 7,
      },
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 112,
      outputTokens: 57,
      cacheReadTokens: 12,
      cacheWriteTokens: 8,
      costUsd: 0.03,
      sawCost: true,
      session: {
        cacheReadTokens: 12,
        cacheWriteTokens: 8,
        costUsd: 0.03,
        inputTokens: 112,
        outputTokens: 57,
        sawCost: true,
      },
    });
  });

  it("resets turn totals and keeps session totals when the turn id changes", () => {
    const previous = {
      turnId: "turn_0",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 8,
      cacheWriteTokens: 5,
      costUsd: 0.01,
      sawCost: true,
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        sawCost: true,
      },
    };
    const next = accumulateTurnUsage({
      previous,
      turnId: "turn_1",
      usage: { inputTokens: 20, outputTokens: 5 },
    });

    expect(next).toEqual({
      turnId: "turn_1",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        cacheReadTokens: 80,
        cacheWriteTokens: 50,
        costUsd: 0.05,
        inputTokens: 1020,
        outputTokens: 505,
        sawCost: true,
      },
    });
  });

  it("treats missing token fields as zero", () => {
    const next = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_0",
      usage: {},
    });

    expect(next).toEqual({
      turnId: "turn_0",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: ZERO_SESSION_USAGE,
    });
  });
});

describe("session state round-trip", () => {
  it("setTurnUsageState writes a fresh state slot the getter can read back", () => {
    const seeded = setTurnUsageState(makeSession(), {
      turnId: "turn_0",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        inputTokens: 5,
        outputTokens: 1,
      },
    });

    expect(getTurnUsageState(seeded.state)).toEqual({
      turnId: "turn_0",
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        inputTokens: 5,
        outputTokens: 1,
      },
    });
  });

  it("getTurnUsageState returns undefined when no state has been stored yet", () => {
    expect(getTurnUsageState(undefined)).toBeUndefined();
    expect(getTurnUsageState({})).toBeUndefined();
  });

  it("preserves unrelated session state slots when writing", () => {
    const seeded = setTurnUsageState(makeSession({ other: "keep me" }), {
      turnId: "turn_0",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      costUsd: 0,
      sawCost: false,
      session: {
        ...ZERO_SESSION_USAGE,
        cacheReadTokens: 1,
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    expect(seeded.state).toMatchObject({ other: "keep me" });
  });
});

describe("session usage limit", () => {
  it("reads zero session usage before token state exists", () => {
    expect(getSessionTokenUsage(makeSession())).toEqual(ZERO_SESSION_USAGE);
    expect(getSessionUsageWindow(makeSession())).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: undefined,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  function sessionAfterStep(
    usage: Partial<NonNullable<HarnessStepResult["usage"]>>,
    session: HarnessSession = makeSession(),
    turnId = "turn_0",
  ) {
    return addTurnUsage(
      session,
      turnId,
      extractTokenUsageDelta({
        costUsd: undefined,
        usage: usage as NonNullable<HarnessStepResult["usage"]>,
      }),
    );
  }

  describe("default limit counts only new input", () => {
    it("excludes cache reads from the window", () => {
      // One model step that replayed 20 cached tokens and sent the rest uncached.
      const session = sessionAfterStep({
        inputTokens: 40_000_010,
        inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 4, noCacheTokens: 39_999_986 },
        outputTokens: 1,
      });

      // Telemetry keeps the raw totals.
      expect(getSessionTokenUsage(session)).toMatchObject({
        cacheReadTokens: 20,
        cacheWriteTokens: 4,
        inputTokens: 40_000_010,
      });
      expect(
        checkSessionUsageLimit({
          canAsk: false,
          limit: DEFAULT_SESSION_USAGE_LIMIT,
          session,
          turnSequence: 0,
        }),
      ).toEqual({ kind: "within" });
    });

    it("counts the full input when the provider reports no cache details", () => {
      const session = sessionAfterStep({ inputTokens: 40_000_000, outputTokens: 1 });

      expect(
        checkSessionUsageLimit({
          canAsk: false,
          limit: DEFAULT_SESSION_USAGE_LIMIT,
          session,
          turnSequence: 0,
        }),
      ).toEqual({
        code: "SESSION_USAGE_LIMIT_REACHED",
        details: {
          total: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 40_000_000,
            outputTokens: 1,
          },
          window: {
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            inputTokens: 40_000_000,
            outputTokens: 1,
          },
        },
        kind: "fail",
        message: "The session reached its usage limit.",
      });
    });
  });

  it("starts a new window after a reset while the total keeps accumulating", () => {
    const session = sessionAfterStep({ inputTokens: 10, outputTokens: 3 });
    const limit: SessionUsageLimit = ({ window }) => window.inputTokens >= 10;

    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session, turnSequence: 0 }),
    ).toMatchObject({ kind: "fail" });

    const reset = resetSessionUsageWindow(session);
    expect(getSessionUsage(reset)).toMatchObject({ inputTokens: 10, outputTokens: 3 });
    expect(getSessionUsageWindow(reset)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session: reset, turnSequence: 0 }),
    ).toEqual({ kind: "within" });

    // Later usage only counts its delta since the reset.
    const later = sessionAfterStep({ inputTokens: 4, outputTokens: 2 }, reset, "turn_1");
    expect(getSessionUsage(later)).toMatchObject({ inputTokens: 14, outputTokens: 5 });
    expect(getSessionUsageWindow(later)).toMatchObject({ inputTokens: 4, outputTokens: 2 });
    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session: later, turnSequence: 1 }),
    ).toEqual({ kind: "within" });

    const much = sessionAfterStep({ inputTokens: 6, outputTokens: 0 }, later, "turn_1");
    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session: much, turnSequence: 1 }),
    ).toMatchObject({
      details: { total: { inputTokens: 20 }, window: { inputTokens: 10 } },
      kind: "fail",
    });
  });

  it("passes the total and the window to the limit", () => {
    const limit = vi.fn<SessionUsageLimit>(() => false);
    const session = sessionAfterStep({ inputTokens: 4, outputTokens: 2 }, undefined, "turn_0");
    const later = sessionAfterStep(
      { inputTokens: 5, outputTokens: 1 },
      resetSessionUsageWindow(session),
      "turn_1",
    );

    expect(
      checkSessionUsageLimit({ canAsk: true, limit, session: later, turnSequence: 1 }),
    ).toEqual({ kind: "within" });
    expect(limit).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith({
      total: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: undefined,
        inputTokens: 9,
        outputTokens: 3,
      },
      window: {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: undefined,
        inputTokens: 5,
        outputTokens: 1,
      },
    });
  });

  it("does not consult the limit on an empty window", () => {
    const limit = vi.fn<SessionUsageLimit>(() => true);

    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session: makeSession(), turnSequence: 0 }),
    ).toEqual({ kind: "within" });
    // A fresh window after a grant is empty too, even though the total is not.
    const reset = resetSessionUsageWindow(sessionAfterStep({ inputTokens: 10, outputTokens: 3 }));
    expect(
      checkSessionUsageLimit({ canAsk: false, limit, session: reset, turnSequence: 1 }),
    ).toEqual({ kind: "within" });
    expect(limit).not.toHaveBeenCalled();
  });

  it("asks to continue when the session can take input", () => {
    const session = sessionAfterStep({ inputTokens: 10, outputTokens: 3 });

    const check = checkSessionUsageLimit({
      canAsk: true,
      limit: () => true,
      session,
      turnSequence: 2,
    });

    expect(check.kind).toBe("ask");
    if (check.kind !== "ask") throw new Error("expected ask");
    expect(check.request.requestId).toBe("wrun_test:2:limit:usage:0");
    expect(check.request.kind).toBe("session-limit");
    expect(check.request.action).toMatchObject({
      input: {
        total: { inputTokens: 10, outputTokens: 3 },
        window: { inputTokens: 10, outputTokens: 3 },
      },
    });
  });

  it("gives each approval window its own ask when only cost advances", () => {
    const limit: SessionUsageLimit = ({ window }) => (window.costUsd ?? 0) >= 1;
    const costStep = (session: HarnessSession) =>
      addTurnUsage(session, "turn_0", extractTokenUsageDelta({ costUsd: 1, usage: undefined }));
    const ask = (session: HarnessSession) => {
      const check = checkSessionUsageLimit({ canAsk: true, limit, session, turnSequence: 0 });
      if (check.kind !== "ask") throw new Error(`expected ask, got ${check.kind}`);
      return check.request.requestId;
    };

    const first = costStep(makeSession());
    const firstId = ask(first);
    expect(ask(first)).toBe(firstId);

    const approved = resetSessionUsageWindow(first);
    expect(
      checkSessionUsageLimit({ canAsk: true, limit, session: approved, turnSequence: 0 }),
    ).toEqual({
      kind: "within",
    });
    const second = costStep(approved);
    expect(getSessionUsage(second)).toMatchObject({ costUsd: 2, inputTokens: 0, outputTokens: 0 });
    expect(ask(second)).not.toBe(firstId);
  });
});

describe("accumulateSessionUsage", () => {
  it("folds a child's totals into the session without touching turn totals", () => {
    const previous = accumulateTurnUsage({
      previous: undefined,
      turnId: "turn_1",
      usage: { inputTokens: 100, outputTokens: 10 },
    });

    const next = accumulateSessionUsage({
      previous,
      usage: { cacheReadTokens: 5, cacheWriteTokens: 2, inputTokens: 400, outputTokens: 40 },
    });

    // Turn-scoped totals unchanged: the child's spend is not this turn's
    // own model-call spend.
    expect(next.turnId).toBe("turn_1");
    expect(next.inputTokens).toBe(100);
    expect(next.outputTokens).toBe(10);
    expect(next.session).toMatchObject({
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      inputTokens: 500,
      outputTokens: 50,
    });
  });

  it("starts from zero when no usage state exists yet", () => {
    const next = accumulateSessionUsage({
      previous: undefined,
      usage: { inputTokens: 400, outputTokens: 40 },
    });

    expect(next.inputTokens).toBe(0);
    expect(next.session).toMatchObject({ inputTokens: 400, outputTokens: 40 });
  });
});
