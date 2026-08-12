import { defineEval } from "eve/evals";

import { sendCompoundDelivery } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle } from "./shared";

/**
 * owner.question.compound.settle-then-run: an accepted answer plus a message in one delivery — the answer settles
 * the question (supersession does not run), then the message runs.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.question.compound.settle-then-run" },
  description:
    "owner.question.compound.settle-then-run: compound answer+message settles the question, then runs the message.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      'Use ask_question to ask whether to use red or blue with exactly these options: id "red", ' +
        'label "Red"; id "blue", label "Blue".',
    );
    const request = t.requireInputRequest({
      optionIds: ["red", "blue"],
      toolName: "ask_question",
    });
    const trace = traceRequest(parked.events, request);

    const delivery = await sendCompoundDelivery(t, {
      inputResponses: [{ requestId: request.requestId, optionId: "red" }],
      message: "After recording my answer, reply with exactly Q4-COMPOUND-OK.",
    });
    const compound = delivery.turn;
    compound.expectOk();
    expectFollowUpSessionActive(compound, parked.sessionId);
    compound.eventsSatisfy(
      "one answer and its closing batch work precede the message",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "red",
          outcome: "answered",
          responder: null,
        }) &&
        exactRequestActionResult(events, trace, { status: "completed" }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: trace.requestId },
          { type: "action.result", actionCallId: trace.callId },
          { type: "message.received" },
        ]),
    );
    compound.messageIncludes(/Q4-COMPOUND-OK/i);

    compound.succeeded();
    await verifyFollowUpTurn(delivery.session, parked.sessionId, "Q4-FOLLOW-UP-OK");
  },
});
