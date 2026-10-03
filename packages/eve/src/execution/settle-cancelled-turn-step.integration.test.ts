import { describe, expect, it } from "vitest";

import { HumanInput, type RelayRoute } from "#harness/human-input/index.js";
import type { SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { filterEventsByType } from "#internal/testing/events.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
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

/**
 * Runs the step in a real runtime, so it publishes through the session's real
 * publication path. Returns the step's result and the events it wrote.
 */
async function settleCancelledTurn(
  input: Omit<Parameters<typeof settleCancelledTurnStep>[0], "sessionWritable">,
) {
  const events: MessageStreamEvent[] = [];
  const decoder = new TextDecoder();
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push(JSON.parse(decoder.decode(chunk)) as MessageStreamEvent);
    },
  });
  const runtime = await createTestRuntime({ agent: { name: "settle-cancelled-turn" } });
  const result = await runtime.run(() =>
    runSessionStateStep({ ...input, sessionWritable }, settleCancelledTurnStep),
  );
  return { ...result, events };
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

      const result = await settleCancelledTurn({
        history: [],
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

  it("withdraws every request the session relays before it reports the turn cancelled", async () => {
    const base = createTestSessionState({
      emissionState: { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn_1" },
      sessionId: "support-session",
    });
    // Alice's turn relays a question from Bob's deploy task and an approval
    // from the reviewer subagent when she cancels it.
    const state = relay(
      relay(base.snapshot.session.state, request("deploy-run-ask-1", "question"), {
        childContinuationToken: "deploy-run-ask-1",
        control: "deploy-run-control",
        runId: "deploy-run",
      }),
      request("reviewer-approval-1", "tool-approval"),
      { childContinuationToken: "reviewer-token" },
    );

    const result = await settleCancelledTurn({
      history: [],
      reportUsage: false,
      serializedContext,
      sessionState: { ...base, snapshot: { session: { ...base.snapshot.session, state } } },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "input.resolved",
      "input.resolved",
      "turn.cancelled",
      "session.waiting",
    ]);
    expect(
      filterEventsByType(result.events, "input.resolved").map((event) => event.data.resolutions),
    ).toEqual([
      [{ kind: "question", outcome: "cancelled", requestId: "deploy-run-ask-1" }],
      [{ kind: "tool-approval", outcome: "cancelled", requestId: "reviewer-approval-1" }],
    ]);
    expect(
      HumanInput.read(readDurableSession(result.sessionState).state).relayedRequestIds(),
    ).toEqual(new Set());
  });
});

function request(requestId: string, kind: "question" | "tool-approval"): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "deploy" },
    kind,
    options: [{ id: "approve", label: "Approve" }],
    prompt: "Ship it?",
    requestId,
  };
}

function relay(
  state: SessionStateMap | undefined,
  asked: InputRequest,
  route: RelayRoute,
): SessionStateMap | undefined {
  return HumanInput.read(state)
    .interrupt({
      at: { sequence: 2, stepIndex: 0, turnId: "turn_1" },
      requests: [asked],
      route,
      type: "relayed.requested",
    })
    .humanInput.write(state);
}
