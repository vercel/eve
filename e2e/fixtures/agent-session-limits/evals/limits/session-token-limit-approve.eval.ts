import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

/**
 * Approving a session token-limit continuation over HTTP while messages queue
 * behind an active model turn.
 */
export default defineEval({
  tags: ["real-model"],
  description:
    "Messages queued during an active turn preserve one limit prompt, and approve resets the budget.",
  timeoutMs: 90_000,
  async test(t) {
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

    const activeState = t.state;
    if (activeState === undefined) {
      throw new Error("The active eval session did not expose client state.");
    }
    // Both messages were queued behind the active turn, so eve delivers them
    // coalesced into one follow-up turn while the limit prompt stays pending.
    const queuedSession = t.target.watchTurn(active.sessionId, {
      startIndex: activeState.streamIndex,
    });
    const queued = await queuedSession.result();
    queued.event("message.received", { count: 1 });
    queued.notEvent("input.requested");
    queued.eventsSatisfy(
      "coalesces messages A and B in order while preserving the pending prompt",
      (events) => {
        const received = events.find((event) => event.type === "message.received");
        if (received === undefined) return false;
        const messageAIndex = received.data.message.indexOf("Queued message A");
        const messageBIndex = received.data.message.indexOf("Queued message B");
        return messageAIndex !== -1 && messageBIndex > messageAIndex;
      },
    );
    t.check(
      [...prompted.events, ...queued.events].filter((event) => event.type === "input.requested")
        .length,
      equals(1),
    );

    const resumed = await queuedSession.session.respond([
      {
        optionId: "continue",
        requestId: request.requestId,
      },
    ]);
    resumed.expectOk();
    resumed.event("step.started");
    resumed.notEvent("input.requested");
    resumed.messageIncludes("approved");
    t.check(resumed.sessionId, equals(active.sessionId));
    t.check(queuedSession.session.sessionId, equals(active.sessionId));

    const nextPrompt = await queuedSession.session.send(
      'Post-approval probe: reply with exactly "same session".',
    );
    nextPrompt.event("input.requested", { count: 1 });
    nextPrompt.notEvent("message.completed");
    t.check(nextPrompt.sessionId, equals(active.sessionId));
    t.check(nextPrompt.status, equals("waiting"));
    t.check(queuedSession.session.sessionId, equals(active.sessionId));

    const nextRequest = queuedSession.session.requireInputRequest({
      display: "confirmation",
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    t.check(
      nextRequest.requestId,
      satisfies(
        (requestId: string) => requestId !== request.requestId,
        "the next token window creates a distinct continuation request",
      ),
    );
  },
});
