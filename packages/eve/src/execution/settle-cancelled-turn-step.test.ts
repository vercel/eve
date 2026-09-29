import { describe, expect, it, vi } from "vitest";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";

// The turn's stream events and channel context are not under test; the usage
// the step reports and the session it persists are.
vi.mock("#context/serialize.js", () => ({
  deserializeContext: async () => ({ get: () => undefined }),
  serializeContext: () => ({}),
}));
vi.mock("#execution/publish-session-events.js", () => ({
  withSessionEventEmitter: async (
    input: { readonly durableSession: HarnessSession },
    emitEvents: (
      emit: () => Promise<void>,
      session: HarnessSession,
    ) => Promise<{ readonly result: unknown; readonly session: HarnessSession }>,
    // Hydration of a session with no compaction history yields empty compaction state.
  ) =>
    await emitEvents(async () => {}, { ...input.durableSession, compaction: {} } as HarnessSession),
}));

function spend<T extends { readonly state?: SessionStateMap }>(
  session: T,
  inputTokens: number,
  turnId: string,
): T {
  return setTurnUsageState(
    session,
    accumulateTurnUsage({
      previous: getTurnUsageState(session.state),
      turnId,
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens, outputTokens: 0 },
    }),
  );
}

describe("settleCancelledTurnStep", () => {
  it.each([
    { reportUsage: true, reported: 50, nextSettled: 0 },
    { reportUsage: false, reported: undefined, nextSettled: 50 },
  ])(
    "reports only what the session spent since its caller's last report (reports usage: $reportUsage)",
    async ({ reportUsage, reported, nextSettled }) => {
      const base = createTestSessionState({
        emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn_2" },
        sessionId: "reviewer-session",
      });
      // The reviewer's first turn spent 100 tokens and settled, reporting them.
      const settled = takeSessionUsageDelta(spend(base.snapshot.session, 100, "turn_1")).session;
      // Its next turn spent 50 more before Alice cancelled it.
      const cancelling = spend(settled, 50, "turn_2");

      const result = await settleCancelledTurnStep({
        reportUsage,
        serializedContext: {},
        sessionState: { ...base, snapshot: { session: cancelling } },
        sessionWritable: new WritableStream<Uint8Array>(),
      });

      expect(result.usage?.inputTokens).toBe(reported);
      // The next settled turn reports whatever the cancel didn't.
      expect(takeSessionUsageDelta(readDurableSession(result.sessionState)).delta.inputTokens).toBe(
        nextSettled,
      );
    },
  );
});
