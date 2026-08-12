import { defineEval } from "eve/evals";

import {
  exactOrder,
  exactTerminal,
  expectWaiting,
  gateLifecycle,
  respond,
  sendCompound,
  traceRequest,
} from "./lifecycle";

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: ["owner.limit.response.settle-continue", "owner.limit.response.settle-stop"],
  },
  description:
    "owner.limit.response.settle-continue / owner.limit.response.settle-stop: Continue runs co-delivered input; Stop cancels and stays resumable.",
  async test(t) {
    gateLifecycle(t);

    await t.send('Reply with exactly "LIMIT-CONTINUE-PRIMER".');
    const prompted = await t.send('Reply with exactly "LIMIT-CONTINUE-PENDING".');
    const request = t.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const trace = traceRequest(prompted.events, request);

    const delivery = await sendCompound(t, {
      inputResponses: [{ requestId: request.requestId, optionId: "continue" }],
      message: "Reply with exactly LIMIT-CONTINUE-COMPOUND-OK.",
    });
    const continued = delivery.turn;
    continued.expectOk();
    expectWaiting(continued, prompted.sessionId);
    continued.eventsSatisfy(
      "Continue settles before the co-delivered message",
      (events) =>
        exactTerminal(events, trace, { optionId: "continue", outcome: "continued" }) &&
        exactOrder(events, [
          {
            type: "input.responded",
            match: (data) => data.requestId === request.requestId,
          },
          { type: "message.received" },
        ]),
    );
    continued.messageIncludes("LIMIT-CONTINUE-COMPOUND-OK");

    const continueFollowUp = await delivery.session.send("LIMIT-CONTINUE-FOLLOW-UP-OK");
    expectWaiting(continueFollowUp, prompted.sessionId);
    const continueFollowUpRequest = delivery.session.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    continueFollowUp.notEvent("message.completed");
    const continueFollowUpResumed = await respond(delivery.session, {
      requestId: continueFollowUpRequest.requestId,
      optionId: "continue",
    });
    expectWaiting(continueFollowUpResumed, prompted.sessionId);
    continueFollowUpResumed.messageIncludes("LIMIT-CONTINUE-FOLLOW-UP-OK");

    const stopSession = t.newSession();
    await stopSession.send('Reply with exactly "LIMIT-STOP-PRIMER".');
    const stopPrompted = await stopSession.send('Reply with exactly "LIMIT-STOP-PENDING".');
    const stopRequest = stopSession.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    const stopTrace = traceRequest(stopPrompted.events, stopRequest);

    const stopped = await respond(stopSession, {
      requestId: stopRequest.requestId,
      optionId: "stop",
    });
    stopped.expectOk();
    expectWaiting(stopped, stopPrompted.sessionId);
    stopped.eventsSatisfy(
      "Stop settles before cancellation",
      (events) =>
        exactTerminal(events, stopTrace, { optionId: "stop", outcome: "stopped" }) &&
        exactOrder(events, [
          {
            type: "input.responded",
            match: (data) => data.requestId === stopRequest.requestId,
          },
          { type: "turn.cancelled" },
          { type: "session.waiting" },
        ]),
    );
    stopped.notEvent("message.completed");

    const afterStop = await stopSession.send("LIMIT-STOP-FOLLOW-UP");
    expectWaiting(afterStop, stopPrompted.sessionId);
    const next = stopSession.requireInputRequest({
      optionIds: ["continue", "stop"],
      toolName: "session_limit_continuation",
    });
    if (next.requestId === stopRequest.requestId) {
      throw new Error("Stop follow-up reused the closed prompt ID.");
    }
    afterStop.notEvent("message.completed");
    const afterStopResumed = await respond(stopSession, {
      requestId: next.requestId,
      optionId: "continue",
    });
    expectWaiting(afterStopResumed, stopPrompted.sessionId);
    afterStopResumed.messageIncludes("LIMIT-STOP-FOLLOW-UP");
  },
});
