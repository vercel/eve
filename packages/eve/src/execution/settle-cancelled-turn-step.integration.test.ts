import { describe, expect, it } from "vitest";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { InputRequest } from "#shared/input.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

/** Runs the step in a real runtime, so it publishes through the session's real publication path. */
async function settleCancelledTurn(
  input: Omit<Parameters<typeof settleCancelledTurnStep>[0], "sessionWritable">,
) {
  const runtime = await createTestRuntime({ agent: { name: "settle-cancelled-turn" } });
  return await runtime.run(() =>
    runSessionStateStep(
      { ...input, sessionWritable: new WritableStream<Uint8Array>() },
      settleCancelledTurnStep,
    ),
  );
}

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
    const result = await settleCancelledTurn({
      reportUsage: false,
      serializedContext: {
        ...serializedContext,
        "eve.activityPendingBlockers": ["child-question-1", "approval-1", "limit-1"],
      },
      sessionState: { ...base, snapshot: { session: { ...base.snapshot.session, ...parked } } },
    });

    expect(result.serializedContext["eve.activityPendingBlockers"]).toEqual(["approval-1"]);
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

      const result = await settleCancelledTurn({
        reportUsage,
        serializedContext,
        sessionState: { ...base, snapshot: { session: cancelling } },
      });

      expect(result.usage?.inputTokens).toBe(reported);
      // The next settled turn reports whatever the cancel didn't.
      expect(takeSessionUsageDelta(readDurableSession(result.sessionState)).delta.inputTokens).toBe(
        nextSettled,
      );
    },
  );
});
