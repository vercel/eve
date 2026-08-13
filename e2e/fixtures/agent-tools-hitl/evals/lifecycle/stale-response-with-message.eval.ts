import { defineEval } from "eve/evals";

import { respondToRequests, sendCompoundDelivery } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestRejection,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle } from "./shared";

/**
 * owner.approval.compound.reject-stale-then-run: a stale response and a message in one delivery — the rejection is
 * explicit and precedes the message, which still runs as a normal turn.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: [
      "owner.approval.response.settle-deny",
      "owner.approval.compound.reject-stale-then-run",
    ],
  },
  description:
    "owner.approval.compound.reject-stale-then-run: stale response is rejected; the co-delivered message still runs.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-10".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const denied = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "deny",
    });
    denied.expectOk();
    expectFollowUpSessionActive(denied, parked.sessionId);
    denied.eventsSatisfy(
      "denial closes the request without executing",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "deny",
          outcome: "denied",
          responder: null,
        }) && exactRequestActionResult(events, trace, { status: "rejected" }),
    );

    const delivery = await sendCompoundDelivery(t, {
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      message: "Reply with exactly AP10-MSG-OK.",
    });
    const compound = delivery.turn;
    compound.expectOk();
    expectFollowUpSessionActive(compound, parked.sessionId);
    compound.eventsSatisfy(
      "one stale rejection precedes the message and no stale action runs",
      (events) =>
        exactRequestRejection(events, trace, "stale") &&
        exactRequestActionResult(events, trace, null) &&
        exactEventOrder(events, [
          { type: "input.response.rejected", requestId: trace.requestId },
          { type: "message.received" },
        ]),
    );
    compound.messageIncludes(/AP10-MSG-OK/i);
    compound.succeeded();
    await verifyFollowUpTurn(delivery.session, parked.sessionId, "AP10-FOLLOW-UP-OK");
  },
});
