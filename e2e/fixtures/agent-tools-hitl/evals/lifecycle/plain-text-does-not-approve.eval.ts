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
 * owner.approval.message.run-open: plain text is never a response. Typing "approve" does not settle the
 * approval; it runs as a message turn, and the request stays answerable
 * through a structured response.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.approval.message.run-open" },
  description:
    "owner.approval.message.run-open: typed 'approve' is a message; only structured responses settle.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-6".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const typed = await t.send("approve");
    typed.expectOk();
    expectFollowUpSessionActive(typed, parked.sessionId);
    typed.event("message.received", { count: 1 });
    typed.event("message.completed", { count: 1 });
    typed.eventsSatisfy(
      "typed approve runs a model turn and settles nothing",
      (events) => noRequestEvents(events, trace) && exactRequestActionResult(events, trace, null),
    );
    const approved = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "only the later structured response settles and executes",
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

    approved.succeeded();
    await verifyFollowUpTurn(t, parked.sessionId, "AP6-FOLLOW-UP-OK");
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
