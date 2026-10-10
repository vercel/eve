import { describe, expect, it } from "vitest";

import { requireSignIn } from "#harness/hitl/approvals.js";
import { sessionView } from "#harness/session-machine/commit.js";
import {
  cancel,
  clear,
  completeSignIn,
  controlled,
  discardAttempt,
  fail,
  hold,
  relay,
  routeAnswer,
  sessionEndedFacts,
} from "#harness/session-machine/transitions.js";
import { createStreamChecker } from "#protocol/session-events/checker.js";
import type { SessionEvent } from "#protocol/session-event.js";
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

/** A turn whose run called a tool and started an agent task, then asked a person to approve. */
function busyTurn(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "tool", capability: { kind: "tool", name: "lookup" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    { data: { callId: "tool" }, scope: { turnId }, type: "call.started" },
    {
      data: { callId: "agent", capability: { kind: "agent", name: "helper" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    {
      data: { kind: "agent", name: "helper", startedBy: { callId: "agent" }, taskId: "task-1" },
      scope: { turnId },
      type: "task.started",
    },
    { data: { callId: "agent", taskId: "task-1" }, scope: { turnId }, type: "call.started" },
    {
      data: {
        interactionId: "approval-1",
        request: { kind: "approval", prompt: "Approve?" },
        subject: { callId: "tool" },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
  ]);
}

/** What `events` settles, by type and id. */
function settledBy(events: readonly SessionEvent[]): Record<string, string> {
  const settled: Record<string, string> = {};
  for (const event of events) {
    if (!("outcome" in event.data)) continue;
    const id = Object.entries(event.data).find(([key]) => key.endsWith("Id"))?.[1];
    settled[`${event.type}:${String(id ?? "")}`] = String(event.data.outcome);
  }
  return settled;
}

describe("closing what a turn leaves open", () => {
  it("fails the turn with its run and calls, keeping the task that outlives it", () => {
    const { events } = fail(viewOf(busyTurn()), { code: "BOOM", message: "It broke." });

    expect(settledBy(events)).toMatchObject({
      "call.settled:tool": "interrupted",
      "interaction.settled:approval-1": "interrupted",
      "model.settled:test_turn_0_0": "failed",
      "turn.settled:turn_0": "failed",
    });
    expect(events.some((event) => event.type === "task.ended")).toBe(false);
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { error: { code: "BOOM", message: "It broke." } },
    });
  });

  it("cancels the turn, interrupting what it asked and stopping its work", () => {
    const { events } = cancel(viewOf(busyTurn()), { cause: { deliveryId: "cancel-1" } });

    expect(settledBy(events)).toMatchObject({
      "call.settled:tool": "interrupted",
      "interaction.settled:approval-1": "interrupted",
      "turn.settled:turn_0": "cancelled",
    });
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { cause: { deliveryId: "cancel-1" } },
    });
  });

  it("abandons a retried attempt's run and calls, and interrupts a steered one's", () => {
    const retried = discardAttempt(viewOf(busyTurn()), { ending: "retried", runId });
    expect(settledBy(retried.events)).toMatchObject({
      "call.settled:tool": "abandoned",
      "model.settled:test_turn_0_0": "abandoned",
    });

    const steered = discardAttempt(viewOf(busyTurn()), { ending: "steered", runId });
    expect(settledBy(steered.events)).toMatchObject({
      "call.settled:tool": "interrupted",
      "model.settled:test_turn_0_0": "completed",
    });
  });

  it("ends the session with everything it left open, the task too", () => {
    const facts = sessionEndedFacts(storedProjection(busyTurn().state), { outcome: "failed" });

    expect(settledBy(facts)).toMatchObject({
      "session.ended:": "failed",
      "task.ended:task-1": "cancelled",
      "turn.settled:turn_0": "failed",
    });
    expect(facts.at(-1)?.type).toBe("session.ended");
  });

  it("commits each closure as one line the contract accepts", () => {
    const session = busyTurn();
    const seed = storedProjection(session.state).view;
    for (const events of [
      fail(viewOf(session), { code: "BOOM", message: "It broke." }).events,
      cancel(viewOf(session)).events,
      sessionEndedFacts(storedProjection(session.state), { outcome: "completed" }),
    ]) {
      const checker = createStreamChecker({ seed });
      expect(
        checker.check({ at: "2026-10-09T00:00:00.000Z", facts: events }, seed!.position),
      ).toEqual([]);
    }
  });
});

/** The callback that completes the GitHub sign-in. */
const GITHUB_CALLBACK = {
  attemptId: "github-1",
  challenge: {},
  hookUrl: "https://example.test/cb",
  name: "github",
};

/** A paused turn waiting on `approval-1` about its call, and on a GitHub sign-in. */
function waitingTurn(): HarnessSession {
  return withPublished(withOpenTurn(BASE, { sequence: 0, stepIndex: 0, turnId }), [
    {
      data: { callId: "tool", capability: { kind: "tool", name: "deploy" }, owner: { runId } },
      scope: { runId, turnId },
      type: "call.requested",
    },
    {
      data: {
        interactionId: "approval-1",
        request: { kind: "approval", prompt: "Approve deploy?" },
        subject: { callId: "tool" },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
    {
      data: {
        interactionId: "github-1",
        request: {
          kind: "sign-in",
          prompt: "Sign in to GitHub",
          signIn: { callbackUrl: "https://example.test/cb", name: "github" },
        },
        subject: { turnId },
      },
      scope: { turnId },
      type: "interaction.opened",
    },
  ]);
}

/** Whether the contract accepts `events` as the next line after `session`'s. */
function accepted(session: HarnessSession, events: readonly SessionEvent[]) {
  const seed = storedProjection(session.state).view;
  return createStreamChecker({ seed }).check(
    { at: "2026-10-10T00:00:00.000Z", facts: events },
    seed!.position,
  );
}

describe("controls and callbacks as deliveries", () => {
  it("admits a cancel, ends the turn naming it, and applies it, in one commit", () => {
    const session = waitingTurn();
    const delivery = { deliveryId: "cancel-1", principal: { id: "alice", type: "user" } };
    const { events } = controlled(delivery, "cancel", (cause) =>
      cancel(viewOf(session), { cause }),
    );

    expect(events[0]).toEqual({
      data: {
        deliveryId: "cancel-1",
        principal: delivery.principal,
        source: { control: "cancel" },
      },
      type: "delivery.admitted",
    });
    expect(events.find((event) => event.type === "turn.settled")).toMatchObject({
      data: { cause: { deliveryId: "cancel-1" }, outcome: "cancelled" },
    });
    expect(events.at(-1)).toEqual({
      data: { deliveryId: "cancel-1", outcome: "applied" },
      type: "delivery.settled",
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("clears by closing the turn and withdrawing its requests before an empty selection", () => {
    const session = waitingTurn();
    const { events } = clear(viewOf(session), {
      cause: { deliveryId: "clear-1" },
      sessionId: "session-1",
    });

    expect(settledBy(events)).toMatchObject({
      "interaction.settled:approval-1": "interrupted",
      "interaction.settled:github-1": "interrupted",
      "turn.settled:turn_0": "cancelled",
    });
    expect(events.at(-1)).toMatchObject({
      data: { kind: "clear", outcome: "completed", selects: null },
      type: "context.settled",
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("completes a sign-in from its callback without recording the provider's payload", () => {
    const session = waitingTurn();
    const { events } = completeSignIn(viewOf(session), {
      completions: [GITHUB_CALLBACK],
    });

    expect(events.map((event) => event.type)).toEqual([
      "delivery.admitted",
      "response.submitted",
      "response.settled",
      "interaction.settled",
      "delivery.settled",
    ]);
    expect(events[1]?.data).toEqual({
      deliveryId: "callback_github-1",
      interactionId: "github-1",
      responseId: "response_callback_github-1",
    });
    expect(events[3]).toMatchObject({
      data: { cause: { responseId: "response_callback_github-1" }, outcome: "accepted" },
    });
    expect(accepted(session, events)).toEqual([]);
  });

  it("ignores a callback for a sign-in that already ended", () => {
    const { events } = completeSignIn(viewOf(BASE), {
      completions: [GITHUB_CALLBACK],
    });
    expect(events).toEqual([]);
  });
});

describe("routing answers", () => {
  it("submits a forwarded answer only for an open request and a delivery it knows", () => {
    const session = waitingTurn();
    const { events } = routeAnswer(viewOf(session), {
      decided: [],
      deliveries: [{ deliveryId: "d-answer" }],
      forwarded: [
        { deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" },
        { deliveryId: "d-answer", interactionId: "gone", responseId: "r-2" },
        { deliveryId: "d-unknown", interactionId: "approval-1", responseId: "r-3" },
      ],
    });

    expect(
      events.filter((event) => event.type === "response.submitted").map((event) => event.data),
    ).toEqual([{ deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" }]);
    expect(accepted(session, events)).toEqual([]);
  });

  it("admits a forwarded answer once the asker admits it, while its batch waits", () => {
    const forwarded = withPublished(waitingTurn(), [
      { data: { deliveryId: "d-answer" }, type: "delivery.admitted" },
      {
        data: { deliveryId: "d-answer", interactionId: "approval-1", responseId: "r-1" },
        type: "response.submitted",
      },
    ]);
    const admitted = (deliveryId: string) =>
      relay(viewOf(forwarded), {
        payload: {
          callId: "tool",
          childSessionId: "child-1",
          event: { data: { deliveryId, interactionId: "approval-1" }, type: "response.admitted" },
          kind: "subagent-authorization-event",
          subagentName: "deployer",
        },
      }).events;

    expect(admitted("d-answer")).toEqual([
      { data: { responseId: "r-1" }, type: "response.admitted" },
    ]);
    expect(accepted(forwarded, admitted("d-answer"))).toEqual([]);
    // An answer already admitted here isn't admitted twice.
    const twice = withPublished(forwarded, admitted("d-answer"));
    expect(
      relay(viewOf(twice), {
        payload: {
          callId: "tool",
          childSessionId: "child-1",
          event: {
            data: { deliveryId: "d-answer", interactionId: "approval-1" },
            type: "response.admitted",
          },
          kind: "subagent-authorization-event",
          subagentName: "deployer",
        },
      }).events,
    ).toEqual([]);
  });
});
