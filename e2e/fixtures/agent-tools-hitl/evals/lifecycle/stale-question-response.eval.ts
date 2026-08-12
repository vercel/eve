import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactRequestActionResult,
  exactRequestRejection,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle } from "./shared";

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.question.response.reject-stale" },
  description:
    "owner.question.response.reject-stale: a response to a closed question is stale turn context, never a new answer.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      'Use ask_question to ask whether to use red or blue with option IDs "red" and "blue".',
    );
    const request = t.requireInputRequest({
      optionIds: ["red", "blue"],
      toolName: "ask_question",
    });
    const trace = traceRequest(parked.events, request);

    const answered = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "red",
    });
    answered.eventsSatisfy(
      "the accepted answer closes the question once",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "red",
          outcome: "answered",
          responder: null,
        }) && exactRequestActionResult(events, trace, { status: "completed" }),
    );

    const stale = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "blue",
    });
    stale.expectOk();
    expectFollowUpSessionActive(stale, parked.sessionId);
    stale.event("message.completed", { count: 1 });
    stale.eventsSatisfy(
      "the closed question rejects the candidate and replays no result",
      (events) =>
        exactRequestRejection(events, trace, "stale") &&
        exactRequestActionResult(events, trace, null),
    );

    await verifyFollowUpTurn(t, parked.sessionId, "STALE-QUESTION-FOLLOW-UP-OK");
  },
});
