import { defineEval } from "eve/evals";

import {
  exactDismissal,
  exactOrder,
  exactStaleRejection,
  expectWaiting,
  gateLifecycle,
  noLifecycleEvents,
  respond,
  traceRequest,
} from "./lifecycle";

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transitions: ["owner.limit.message.supersede", "owner.limit.response.reject-stale"] },
  description:
    "owner.limit.message.supersede / owner.limit.response.reject-stale: a message opens a fresh generation and the old response is stale.",
  async test(t) {
    gateLifecycle(t);

    await t.send('Reply with exactly "LIMIT-REPROMPT-PRIMER".');
    const prompted = await t.send('Reply with exactly "LIMIT-REPROMPT-ORIGINAL".');
    const first = t.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const firstTrace = traceRequest(prompted.events, first);

    const reprompted = await t.send("LIMIT-REPROMPT-DISCARDED");
    expectWaiting(reprompted, prompted.sessionId);
    const second = t.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const secondTrace = traceRequest(reprompted.events, second);
    if (second.requestId === first.requestId) throw new Error("Re-prompt reused its request ID.");
    reprompted.eventsSatisfy(
      "old prompt is dismissed before one fresh prompt without a model call",
      (events) =>
        exactDismissal(events, firstTrace, "superseded") &&
        noLifecycleEvents(events, secondTrace) &&
        exactOrder(events, [
          {
            type: "input.dismissed",
            match: (data) => data.requestId === first.requestId,
          },
          {
            type: "input.requested",
            match: (data) =>
              Array.isArray(data.requests) &&
              data.requests.some(
                (request) =>
                  typeof request === "object" &&
                  request !== null &&
                  "requestId" in request &&
                  request.requestId === second.requestId,
              ),
          },
        ]),
    );
    reprompted.notEvent("message.completed");

    const stale = await respond(t, { requestId: first.requestId, optionId: "continue" });
    expectWaiting(stale, prompted.sessionId);
    stale.eventsSatisfy(
      "stale old-prompt response leaves the fresh prompt unchanged",
      (events) => exactStaleRejection(events, firstTrace) && noLifecycleEvents(events, secondTrace),
    );
    stale.notEvent("message.completed");
    stale.notEvent("turn.cancelled");

    const resumed = await respond(t, { requestId: second.requestId, optionId: "continue" });
    expectWaiting(resumed, prompted.sessionId);
    resumed.messageIncludes("LIMIT-REPROMPT-ORIGINAL");
    resumed.notEvent("message.received", {
      data: { message: "LIMIT-REPROMPT-DISCARDED" },
    });

    const followUpPrompt = await t.send("LIMIT-REPROMPT-FOLLOW-UP-OK");
    expectWaiting(followUpPrompt, prompted.sessionId);
    const followUpRequest = t.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    followUpPrompt.notEvent("message.completed");
    const followUp = await respond(t, {
      requestId: followUpRequest.requestId,
      optionId: "continue",
    });
    expectWaiting(followUp, prompted.sessionId);
    followUp.messageIncludes("LIMIT-REPROMPT-FOLLOW-UP-OK");
  },
});
