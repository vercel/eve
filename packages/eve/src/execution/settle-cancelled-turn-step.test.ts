import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ActivityPendingBlockersKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import type {
  RestoredSessionStep,
  SessionStepPublication,
} from "#execution/publish-session-events.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputRequest } from "#shared/input.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";

// The turn's stream events and channel context are not under test; the usage
// the step reports and the session it persists are.
vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(async () => new ContextContainer()),
  serializeContext: () => ({}),
}));
vi.mock("#execution/publish-session-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/publish-session-events.js")>()),
  publishFromSessionStep: async (
    step: RestoredSessionStep,
    publication: SessionStepPublication<unknown, unknown>,
  ) => {
    // Hydration of a session with no compaction history yields empty compaction state.
    const session = { ...step.durableSession, compaction: {} } as HarnessSession;
    const update = publication.updateSession?.(
      session,
      await publication.publish(async () => {}, session),
    ) ?? { session };
    return {
      published: {
        serializedContext: {},
        sessionState: createDurableSessionState({ session: update.session }),
      },
      result: update.result,
    };
  },
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

function request(requestId: string, kind: InputRequest["kind"]): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "deploy" },
    kind,
    prompt: "Continue?",
    requestId,
  };
}

describe("settleCancelledTurnStep", () => {
  it("leaves only the requests the session can still answer holding its activity open", async () => {
    const base = createTestSessionState({
      emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn_1" },
      sessionId: "deploy-session",
    });
    // Alice's turn waits on its own deploy approval, a session-limit prompt,
    // and a question a child asked through it when Bob cancels the turn.
    const parked = [request("approval-1", "tool-approval"), request("limit-1", "session-limit")]
      .map((pending) => [pending])
      .reduce(
        (session, requests) => appendPendingInputBatch({ requests, responseMessages: [], session }),
        { state: base.snapshot.session.state } as HarnessSession,
      );
    const ctx = new ContextContainer();
    ctx.set(ActivityPendingBlockersKey, ["child-question-1", "approval-1", "limit-1"]);
    vi.mocked(deserializeContext).mockResolvedValueOnce(ctx);

    await settleCancelledTurnStep({
      reportUsage: false,
      serializedContext: {},
      sessionState: { ...base, snapshot: { session: { ...base.snapshot.session, ...parked } } },
      sessionWritable: new WritableStream<Uint8Array>(),
    });

    expect(ctx.get(ActivityPendingBlockersKey)).toEqual(["approval-1"]);
  });

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

      const result = await runSessionStateStep(
        {
          reportUsage,
          serializedContext: {},
          sessionState: { ...base, snapshot: { session: cancelling } },
          sessionWritable: new WritableStream<Uint8Array>(),
        },
        settleCancelledTurnStep,
      );

      expect(result.usage?.inputTokens).toBe(reported);
      // The next settled turn reports whatever the cancel didn't.
      expect(takeSessionUsageDelta(readDurableSession(result.sessionState)).delta.inputTokens).toBe(
        nextSettled,
      );
    },
  );
});
