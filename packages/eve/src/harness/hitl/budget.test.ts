import { describe, expect, it, vi } from "vitest";
import {
  checkSessionUsageLimit,
  createSessionLimitContinuationRequest,
  DEFAULT_SESSION_USAGE_LIMIT,
  limitDecision,
  withoutStaleBudgetAnswers,
} from "#harness/hitl/budget.js";
import { NO_USAGE } from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionUsageLimit } from "#shared/agent-definition.js";
import { interactionOpened, interactionSettled } from "#harness/interaction-facts.js";
import { tablesOf } from "#internal/testing/session-machine.js";
import { acceptSessionBudget, withSessionUsage } from "#internal/testing/session-usage.js";
import type { SessionEvent } from "#protocol/session-event.js";

const session = { sessionId: "alice", state: {} } as HarnessSession;

describe("session usage policy", () => {
  it("counts new input and cache writes, but not cache reads, by default", () => {
    const input = { canAsk: true, session, turnSequence: 0, limit: DEFAULT_SESSION_USAGE_LIMIT };
    expect(
      checkSessionUsageLimit({
        ...input,
        usage: { ...NO_USAGE, inputTokens: 80_000_000, cacheReadTokens: 40_000_001 },
      }).kind,
    ).toBe("within");
    expect(
      checkSessionUsageLimit({
        ...input,
        usage: {
          ...NO_USAGE,
          inputTokens: 80_000_000,
          cacheReadTokens: 40_000_000,
          cacheWriteTokens: 5_000_000,
        },
      }).kind,
    ).toBe("ask");
  });

  it("does not call authored code for an empty window", () => {
    const limit = vi.fn(() => true);
    expect(
      checkSessionUsageLimit({ canAsk: true, session, turnSequence: 0, limit, usage: NO_USAGE })
        .kind,
    ).toBe("within");
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "passes lifetime and window usage to the authored policy (can ask: %s)",
    (canAsk) => {
      const prior = { ...NO_USAGE, inputTokens: 35, costUsd: 0.25 };
      const current = { ...NO_USAGE, inputTokens: 45, costUsd: 0.5 };
      const reset = acceptSessionBudget(withSessionUsage(session, prior));
      const limit = vi.fn<SessionUsageLimit>(({ window }) => (window.costUsd ?? 0) >= 0.25);
      const result = checkSessionUsageLimit({
        canAsk,
        session: reset,
        turnSequence: 1,
        limit,
        usage: current,
      });
      expect(limit).toHaveBeenCalledWith({
        total: current,
        window: { ...NO_USAGE, inputTokens: 10, costUsd: 0.25 },
      });
      expect(result.kind).toBe(canAsk ? "ask" : "fail");
      if (result.kind === "fail")
        expect(result).toMatchObject({
          code: "SESSION_USAGE_LIMIT_REACHED",
          details: { total: current },
        });
      if (result.kind === "ask") expect(result.ask.interactionId).toBe("alice:1:limit:usage:1");
    },
  );

  it("does not let a JavaScript policy mutate committed usage or failure details", () => {
    const usage = { ...NO_USAGE, inputTokens: 10 };
    const result = checkSessionUsageLimit({
      canAsk: false,
      session,
      turnSequence: 0,
      usage,
      limit: ({ total, window }) => {
        Object.assign(total, { inputTokens: 0 });
        Object.assign(window, { outputTokens: 99 });
        return true;
      },
    });
    expect(usage).toEqual({ ...NO_USAGE, inputTokens: 10 });
    expect(result).toMatchObject({
      kind: "fail",
      details: {
        total: { inputTokens: 10, outputTokens: 0 },
        window: { inputTokens: 10, outputTokens: 0 },
      },
    });
  });

  it("allows an authored uncapped policy", () => {
    expect(
      checkSessionUsageLimit({
        canAsk: false,
        session,
        turnSequence: 0,
        limit: () => false,
        usage: { ...NO_USAGE, inputTokens: 100_000_000 },
      }).kind,
    ).toBe("within");
  });
});

describe("session usage continuation", () => {
  it("keeps the prompt stable within a turn and window, but changes it for either boundary", () => {
    const input = { sessionId: "alice", turnSequence: 2, windowIndex: 3 };
    const ask = createSessionLimitContinuationRequest(input);
    expect(ask).toEqual(createSessionLimitContinuationRequest(input));
    expect(ask.interactionId).toBe("alice:2:limit:usage:3");
    expect(ask.request).toMatchObject({
      kind: "budget",
      allowFreeform: false,
      options: [{ id: "approve" }, { id: "deny" }],
    });
    expect(
      createSessionLimitContinuationRequest({ ...input, windowIndex: 4 }).interactionId,
    ).not.toBe(ask.interactionId);
    expect(
      createSessionLimitContinuationRequest({ ...input, turnSequence: 3 }).interactionId,
    ).not.toBe(ask.interactionId);
  });

  it("grants on approve, declines on deny, and leaves other responses unanswered", () => {
    expect(limitDecision({ optionId: "approve" })).toEqual({ granted: true });
    expect(limitDecision({ optionId: "deny" })).toEqual({ granted: false });
    expect(limitDecision({})).toBeUndefined();
  });
});

describe("stale budget answers", () => {
  const prompt = {
    kind: "budget",
    options: [{ id: "approve", label: "Approve" }],
    prompt: "?",
  } as const;
  const approval = { ...prompt, kind: "approval" } as const;
  const tables = tablesOf([
    { data: {}, type: "session.started" },
    {
      data: { cause: { deliveryId: "d0" }, follows: null, turnId: "turn_0" },
      type: "turn.started",
    },
    interactionOpened({ interactionId: "earlier", request: prompt, subject: { turnId: "turn_0" } }),
    interactionSettled("earlier", "accepted"),
    interactionOpened({ interactionId: "current", request: prompt, subject: { turnId: "turn_0" } }),
    interactionOpened({
      interactionId: "approval",
      request: approval,
      subject: { turnId: "turn_0" },
    }),
    interactionSettled("approval", "accepted"),
  ] as SessionEvent[]);
  const answer = (interactionId: string, optionId = "approve") => ({
    deliveryId: "delivery",
    interactionId,
    optionId,
    responseId: `response-${interactionId}`,
  });

  it("drops an answer to a closed budget prompt by its kind and keeps the rest", () => {
    const stepInput = withoutStaleBudgetAnswers({
      pendingRequestIds: new Set(["current"]),
      stepInput: {
        answers: [answer("earlier", "deny"), answer("current"), answer("approval"), answer("gone")],
        message: "also do this",
      },
      tables,
    });

    // The current prompt's answer stands; other stale answers become text later, never grants.
    expect(stepInput).toEqual({
      answers: [answer("current"), answer("approval"), answer("gone")],
      message: "also do this",
    });
  });

  it("returns the input unchanged when no stale budget answer arrives", () => {
    const stepInput = { answers: [answer("current"), answer("approval")] };
    expect(
      withoutStaleBudgetAnswers({ pendingRequestIds: new Set(["current"]), stepInput, tables }),
    ).toBe(stepInput);
  });
});
