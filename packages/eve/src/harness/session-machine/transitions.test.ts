import { describe, expect, it } from "vitest";

import { requireSignIn } from "#harness/hitl/approvals.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { hold, sessionEndedFacts } from "#harness/session-machine/transitions.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
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

describe("hold on tasks", () => {
  it("awaits the task calls still working after the session restores", () => {
    const session = withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
      {
        data: { callId: "child", capability: { kind: "agent", name: "child" }, owner: { runId } },
        scope: { runId, turnId },
        type: "call.requested",
      },
      {
        data: { kind: "agent", name: "child", startedBy: { callId: "child" }, taskId: "task-1" },
        scope: { turnId },
        type: "task.started",
      },
      { data: { callId: "child", taskId: "task-1" }, scope: { turnId }, type: "call.started" },
    ]);
    // The checkpoint keeps only what a step reads: the public tables, not reader-side tasks.
    const restored = sessionView(storedProjection(session.state), session.state);

    const { events } = hold(restored, { on: "tasks" });

    expect(events).toEqual([
      { data: { awaiting: [{ callId: "child" }], turnId }, scope: { turnId }, type: "turn.paused" },
    ]);
  });
});

describe("sessionEndedFacts", () => {
  it("starts a session that ends before it started, so the end has something to end", () => {
    const facts = sessionEndedFacts(initialSessionProjection(), { outcome: "failed" });
    expect(facts.map((event) => event.type)).toEqual(["session.started", "session.ended"]);
  });

  it("doesn't start a session twice", () => {
    const projection = storedProjection(runningCall().state);
    const facts = sessionEndedFacts(projection, { outcome: "completed" });
    expect(facts.filter((event) => event.type === "session.started")).toEqual([]);
  });
});
