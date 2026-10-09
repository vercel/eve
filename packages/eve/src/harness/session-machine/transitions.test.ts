import { describe, expect, it } from "vitest";

import { requireSignIn } from "#harness/hitl/approvals.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { hold } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type { HarnessSession } from "#harness/types.js";
import { withOpenTurn, withPublished } from "#internal/testing/session-machine.js";

const BASE: HarnessSession = {
  agent: { modelReference: { id: "test" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 0.8 },
  continuationToken: "test",
  history: [],
  sessionId: "session-1",
};
const turnId = "turn_0";
const runId = `test_${turnId}_0`;

function viewOf(session: HarnessSession) {
  return sessionView(storedProjection(session.state), session.state);
}

/** A turn whose run called `probe`, which started and is still running. */
function runningCall(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "probe", capability: { kind: "tool", name: "auth-probe" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "probe" }, scope: { turnId }, type: "call.started" },
  ]);
}

describe("requireSignIn", () => {
  it("settles the call a sign-in stopped, before it opens the sign-in", () => {
    const { events } = requireSignIn(viewOf(runningCall()), {
      callIdsByName: new Map([["auth-probe", ["probe"]]]),
      challenges: [
        {
          attemptId: "attempt-1",
          challenge: { url: "https://example.test/sign-in" },
          hookUrl: "https://example.test/callback",
          name: "auth-probe",
        },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "call.settled",
      "interaction.opened",
      "turn.paused",
    ]);
    expect(events[0]).toMatchObject({
      data: { callId: "probe", outcome: "interrupted", reason: "authorization-required" },
    });
  });
});

describe("hold", () => {
  it("answers for now a delivery whose answer the paused turn hasn't acted on", () => {
    const session = withPublished(runningCall(), [
      {
        data: {
          interactionId: "approval-1",
          request: { kind: "approval", prompt: "Approve?" },
          subject: { callId: "probe" },
        },
        scope: { turnId },
        type: "interaction.opened",
      },
      {
        data: { awaiting: [{ interactionId: "approval-1" }], turnId },
        scope: { turnId },
        type: "turn.paused",
      },
      { data: { deliveryId: "answer-1" }, type: "delivery.admitted" },
      {
        data: {
          deliveryId: "answer-1",
          interactionId: "approval-1",
          responseId: "response-1",
          value: { optionId: "approve" },
        },
        type: "response.submitted",
      },
    ]);

    const { events } = hold(viewOf(session), { on: "input" });

    expect(events).toContainEqual({
      data: { deliveryId: "answer-1", outcome: "awaiting-input", turnId },
      type: "delivery.settled",
    });
  });
});
