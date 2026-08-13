import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  noRequestEvents,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * owner.approval.message.run-open + owner.approval.response.settle-allow-after-turns: a message while an approval is open runs as a normal turn and
 * changes nothing about the request; a later accepted response still restores
 * the ApprovalBatch group and runs the tool once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: [
      "owner.approval.message.run-open",
      "owner.approval.response.settle-allow-after-turns",
    ],
  },
  description:
    "owner.approval.message.run-open/owner.approval.response.settle-allow-after-turns: messages never wedge; the approval stays answerable across turns.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-4".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    // owner.approval.message.run-open: the message runs as a normal turn; the request is untouched.
    const intervening = await t.send(
      "Ignore the pending approval. Reply with exactly AP4-TURN-OK.",
    );
    intervening.expectOk();
    expectFollowUpSessionActive(intervening, parked.sessionId);
    intervening.messageIncludes(/AP4-TURN-OK/i);
    intervening.event("message.received", { count: 1 });
    intervening.eventsSatisfy(
      "no request lifecycle event for the open approval",
      (events) => noRequestEvents(events, trace) && exactRequestActionResult(events, trace, null),
    );

    // owner.approval.response.settle-allow-after-turns: the approval settles after the intervening turn; the tool runs once.
    const approved = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "late approval settles and runs its original call once",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: null,
        }) &&
        exactRequestActionResult(events, trace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: trace.requestId },
          { type: "action.result", actionCallId: trace.callId },
        ]),
    );
    t.eventsSatisfy("the intervening turn stays before restored batch work", (events) =>
      exactEventOrder(events, [
        {
          type: "message.received",
          match: (data) => typeof data.message === "string" && data.message.includes("AP4-TURN-OK"),
        },
        { type: "input.responded", requestId: trace.requestId },
        { type: "action.result", actionCallId: trace.callId },
      ]),
    );

    approved.succeeded();
    await verifyFollowUpTurn(t, parked.sessionId, "AP4-FOLLOW-UP-OK");
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
