import { describe, expect, it } from "vitest";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { filterEventsByType } from "#internal/testing/events.js";
import { createInputRequestedEvent, type MessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
import { withPublished } from "#internal/testing/session-machine.js";
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
      const base = createTestSessionState(
        {
          sessionId: "reviewer-session",
        },
        { sequence: 1, stepIndex: 0, turnId: "turn_2" },
      );
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
    const base = createTestSessionState(
      {
        sessionId: "support-session",
      },
      { sequence: 3, stepIndex: 1, turnId: "turn_1" },
    );
    // Alice's turn relays a question from Bob's deploy task and an approval
    // from the reviewer subagent when she cancels it.
    const state = relay(
      relay(base.snapshot.session.state, "deploy-run-ask-1", {
        kind: "question",
        runId: "deploy-run",
        workflowAsk: { control: "deploy-run-control" },
      }),
      "reviewer-approval-1",
      { kind: "tool-approval" },
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
    expect(getProxyInputRequests(readDurableSession(result.sessionState).state).size).toBe(0);
  });
});

/** Relays a child's request: the session publishes it, then keeps its route. */
function relay(
  state: SessionStateMap | undefined,
  requestId: string,
  route: Pick<ProxyInputRequest, "kind" | "runId" | "workflowAsk">,
): SessionStateMap | undefined {
  const event = { sequence: 2, stepIndex: 0, turnId: "turn_1" };
  const request: InputRequest = {
    action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "deploy" },
    kind: route.kind,
    prompt: "Approve deploy?",
    requestId,
  };
  const published = withPublished({ ...openSession, state }, [
    createInputRequestedEvent({ callId: `${requestId}-served`, requests: [request], ...event }),
  ]);
  return upsertProxyInputRequestState({
    entries: [[requestId, { ...route, childContinuationToken: requestId, event }]],
    forChildContinuationToken: requestId,
    state: published.state,
  });
}

const openSession: HarnessSession = {
  agent: { dynamicModel: true, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "test-token",
  history: [],
  sessionId: "support-session",
};
