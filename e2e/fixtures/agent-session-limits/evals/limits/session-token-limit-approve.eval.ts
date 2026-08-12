import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { exactDismissal, exactOrder, gateLifecycle, traceRequest } from "./lifecycle";

/**
 * Deliveries admitted while a turn is active preserve arrival order. Once
 * the turn parks on a Limit prompt, each queued message supersedes the
 * current generation without reaching the model.
 */
export default defineEval({
  tags: ["real-model"],
  metadata: {
    transitions: [
      "scheduler.delivery.admit-arrival-order",
      "owner.limit.message.supersede",
      "owner.limit.response.settle-continue",
    ],
  },
  description:
    "Buffered active-turn deliveries are admitted in order; each supersedes the current Limit generation.",
  timeoutMs: 90_000,
  async test(t) {
    gateLifecycle(t);
    const active = await t.start(
      'Call the `hold-open` tool exactly once with marker "limit-race". Wait for its result, then reply with exactly "approved".',
    );
    await active.waitForEvent("actions.requested");

    const deliverWhileActive = async (message: string): Promise<void> => {
      const response = await t.target.fetch(
        `/eve/v1/session/${encodeURIComponent(active.sessionId)}`,
        {
          body: JSON.stringify({ message, turnPolicy: "queue" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) {
        throw new Error(`Concurrent delivery failed (${String(response.status)}).`);
      }
    };

    await deliverWhileActive('Queued message A: preserve the original reply "approved".');
    await deliverWhileActive('Queued message B: preserve the original reply "approved".');

    const prompted = await active.result();
    prompted.event("input.requested", { count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const firstTrace = traceRequest(prompted.events, request);

    const activeState = t.state;
    if (activeState === undefined) {
      throw new Error("The active eval session did not expose client state.");
    }
    const queuedSession = t.target.watchTurn(active.sessionId, {
      startIndex: activeState.streamIndex,
    });
    const queuedA = await queuedSession.result();
    queuedA.event("message.received", { count: 1 });
    const second = queuedSession.session.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const secondTrace = traceRequest(queuedA.events, second);
    queuedA.eventsSatisfy(
      "message A supersedes generation one before generation two opens",
      (events) =>
        exactDismissal(events, firstTrace, "superseded") &&
        exactOrder(events, [
          { type: "input.dismissed", match: (data) => data.requestId === request.requestId },
          { type: "input.requested" },
        ]),
    );
    queuedA.notEvent("message.completed");
    const queuedState = queuedSession.session.state;
    if (queuedState === undefined) {
      throw new Error("The attached eval session did not expose client state.");
    }
    const queuedBSession = t.target.watchTurn(active.sessionId, {
      startIndex: queuedState.streamIndex,
    });
    const queuedB = await queuedBSession.result();
    queuedB.event("message.received", { count: 1 });
    const third = queuedBSession.session.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const thirdTrace = traceRequest(queuedB.events, third);
    queuedB.eventsSatisfy(
      "message B supersedes generation two before generation three opens",
      (events) =>
        exactDismissal(events, secondTrace, "superseded") &&
        exactOrder(events, [
          { type: "input.dismissed", match: (data) => data.requestId === second.requestId },
          { type: "input.requested" },
        ]),
    );
    queuedB.notEvent("message.completed");
    t.check(new Set([request.requestId, second.requestId, third.requestId]).size, equals(3));

    const resumed = await queuedBSession.session.respond([
      {
        optionId: "continue",
        requestId: thirdTrace.requestId,
      },
    ]);
    resumed.expectOk();
    resumed.event("step.started");
    resumed.notEvent("input.requested");
    resumed.messageIncludes("approved");
    resumed.eventsSatisfy("superseding messages are not replayed", (events) =>
      events.every(
        (event) =>
          event.type !== "message.received" || !event.data.message.includes("Queued message"),
      ),
    );
    t.check(resumed.sessionId, equals(active.sessionId));
    t.check(queuedBSession.session.sessionId, equals(active.sessionId));

    const nextPrompt = await queuedBSession.session.send(
      'Post-approval probe: reply with exactly "same session".',
    );
    nextPrompt.event("input.requested", { count: 1 });
    nextPrompt.notEvent("message.completed");
    t.check(nextPrompt.sessionId, equals(active.sessionId));
    t.check(nextPrompt.status, equals("waiting"));
    t.check(queuedBSession.session.sessionId, equals(active.sessionId));

    const nextRequest = queuedBSession.session.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    t.check(
      nextRequest.requestId,
      satisfies(
        (requestId: string) => requestId !== third.requestId,
        "the next token window creates a distinct continuation request",
      ),
    );
  },
});
