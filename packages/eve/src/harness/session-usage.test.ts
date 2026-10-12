import { describe, expect, it } from "vitest";

import {
  bumpSessionRuntimeUsageLimits,
  getSessionRemainingUsageQuota,
  getSessionRuntimeUsageLimits,
  getSessionUsageLimitViolation,
  markUsageReported,
  NO_USAGE,
  sessionUsage,
  takeSessionUsageDelta,
  turnUsage,
} from "#harness/session-usage.js";
import type { HarnessSession } from "#harness/types.js";
import { withSessionUsage } from "#internal/testing/session-usage.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";

function makeSession(limits?: HarnessSession["limits"]): HarnessSession {
  return {
    agent: { modelReference: { id: "model_x" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "ct_test",
    history: [],
    limits,
    sessionId: "wrun_test",
  };
}

const spent = (inputTokens: number, outputTokens = 0) => ({
  ...NO_USAGE,
  inputTokens,
  outputTokens,
});

describe("what a session spent", () => {
  it("is what its view records, nothing before it records any", () => {
    expect(sessionUsage(makeSession())).toEqual(NO_USAGE);
    expect(sessionUsage(withSessionUsage(makeSession(), { inputTokens: 7 }))).toEqual(spent(7));
  });

  it("a turn's is what its own runs spent, its summary runs too, but not its calls' delegates", () => {
    const view = emptySessionView();
    const usage = (inputTokens: number) => ({ ...spent(inputTokens), costUsd: 0.01 });
    const facts: SessionEvent[] = [
      { data: {}, type: "session.started" },
      { data: { deliveryId: "d_1" }, type: "delivery.admitted" },
      {
        data: { cause: { deliveryId: "d_1" }, follows: null, turnId: "t_1" },
        type: "turn.started",
      },
      { data: { owner: { turnId: "t_1" }, runId: "r_1" }, type: "model.requested" },
      {
        data: { kind: "model", owner: { runId: "r_1" }, usage: usage(10) },
        type: "usage.recorded",
      },
      {
        data: {
          callId: "c_1",
          capability: { kind: "agent", name: "helper" },
          owner: { runId: "r_1" },
        },
        type: "call.requested",
      },
      {
        data: { kind: "model", owner: { callId: "c_1" }, usage: usage(500) },
        type: "usage.recorded",
      },
      { data: { changeId: "x_1", kind: "compaction", turnId: "t_1" }, type: "context.started" },
      { data: { owner: { changeId: "x_1" }, runId: "r_2" }, type: "model.requested" },
      { data: { kind: "model", owner: { runId: "r_2" }, usage: usage(5) }, type: "usage.recorded" },
    ];
    foldLine(view, { at: "2026-01-01T00:00:00.000Z", facts }, 0);

    expect(turnUsage(view, "t_1")).toEqual({ ...spent(15), costUsd: 0.02 });
    expect(view.usage.total.inputTokens).toBe(515);
  });
});

describe("session token limits", () => {
  it.each([
    {
      expected: { kind: "input", limit: 10, usedTokens: 10 },
      limits: { maxInputTokensPerSession: 10 },
    },
    {
      expected: { kind: "output", limit: 3, usedTokens: 3 },
      limits: { maxOutputTokensPerSession: 3 },
    },
  ])("reports the first exhausted $expected.kind limit", ({ expected, limits }) => {
    const session = withSessionUsage(makeSession(limits), spent(10, 3));
    expect(getSessionUsageLimitViolation(session)).toEqual(expected);
  });

  it("checks what the step's view spent, when the step passes it", () => {
    const session = makeSession({ maxInputTokensPerSession: 10 });
    expect(getSessionUsageLimitViolation(session)).toBeNull();
    expect(getSessionUsageLimitViolation(session, spent(12))).toMatchObject({ usedTokens: 12 });
  });

  it("checks usage against the bumped runtime limit after a grant", () => {
    const limits = { maxInputTokensPerSession: 10, maxOutputTokensPerSession: 3 };
    const session = withSessionUsage(makeSession(limits), spent(10, 3));
    expect(getSessionUsageLimitViolation(session)).toEqual({
      kind: "input",
      limit: 10,
      usedTokens: 10,
    });

    const bumped = bumpSessionRuntimeUsageLimits(session);
    // Both axes bump together so a session near two limits gets one prompt.
    expect(getSessionRuntimeUsageLimits(bumped)).toEqual({ inputTokens: 20, outputTokens: 6 });
    expect(getSessionUsageLimitViolation(bumped)).toBeNull();

    // `limit` reports the configured window size; `usedTokens` the lifetime total.
    expect(getSessionUsageLimitViolation(withSessionUsage(bumped, spent(20, 3)))).toEqual({
      kind: "input",
      limit: 10,
      usedTokens: 20,
    });
  });

  it("every grant moves the runtime limit, even after a large overshoot", () => {
    // A single model call overshot the 10-token window by several windows.
    const session = withSessionUsage(makeSession({ maxInputTokensPerSession: 10 }), spent(35));
    expect(getSessionUsageLimitViolation(session)).toMatchObject({ usedTokens: 35 });

    // One approval always unblocks: the limit re-anchors to usage plus the configured limit.
    const bumped = bumpSessionRuntimeUsageLimits(session);
    expect(getSessionRuntimeUsageLimits(bumped)).toEqual({ inputTokens: 45 });
    expect(getSessionUsageLimitViolation(bumped)).toBeNull();

    const later = withSessionUsage(bumped, spent(45));
    expect(getSessionUsageLimitViolation(later)).not.toBeNull();
    expect(getSessionRuntimeUsageLimits(bumpSessionRuntimeUsageLimits(later))).toEqual({
      inputTokens: 55,
    });
  });

  it("reports remaining quota from the runtime limit", () => {
    const session = withSessionUsage(makeSession({ maxInputTokensPerSession: 10 }), spent(4, 9));
    expect(getSessionRemainingUsageQuota(session)).toEqual({
      costUsd: false,
      inputTokens: 6,
      outputTokens: false,
    });
    expect(getSessionRemainingUsageQuota(makeSession())).toEqual({
      costUsd: false,
      inputTokens: false,
      outputTokens: false,
    });
  });
});

describe("usage a child reports", () => {
  it("is what it spent since the last report, with no cost until one is reported", () => {
    const first = takeSessionUsageDelta(withSessionUsage(makeSession(), spent(10)));
    expect(first.delta).toEqual({ ...spent(10), costUsd: undefined });

    const later = withSessionUsage(first.session, { costUsd: 0.5, inputTokens: 30 });
    expect(takeSessionUsageDelta(later).delta).toEqual({ ...spent(20), costUsd: 0.5 });
  });

  it("leaves out what was spent outside its turns", () => {
    const compacted = markUsageReported(withSessionUsage(makeSession(), spent(40)), spent(40));
    const turn = withSessionUsage(compacted, spent(55));
    expect(takeSessionUsageDelta(turn).delta).toMatchObject({ inputTokens: 15 });
  });
});
