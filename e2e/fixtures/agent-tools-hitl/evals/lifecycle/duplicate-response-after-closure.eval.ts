import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestRejection,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * owner.approval.response.reject-stale: a duplicate response referencing a closed request
 * is stale — it changes no request, never executes the tool a second time, and
 * still initiates a turn with the stale-attempt context.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: ["owner.approval.response.settle-allow", "owner.approval.response.reject-stale"],
  },
  description:
    "owner.approval.response.reject-stale: responses after closure are stale; no second adjudication or execution.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-9".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const approved = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "the first approve settles and executes exactly once",
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

    // owner.approval.response.reject-stale: the same approve in a new delivery is stale.
    const stale = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    stale.expectOk();
    expectFollowUpSessionActive(stale, parked.sessionId);
    stale.event("message.completed", { count: 1 });
    stale.eventsSatisfy(
      "the duplicate is one stale rejection with no second execution",
      (events) =>
        exactRequestRejection(events, trace, "stale") &&
        exactRequestActionResult(events, trace, null) &&
        exactEventOrder(events, [
          { type: "input.response.rejected", requestId: trace.requestId },
          { type: "message.completed" },
          { type: "session.waiting" },
        ]),
    );

    t.eventsSatisfy("one matching execution overall", (events) =>
      exactRequestActionResult(events, trace, {
        output: GUARDED_ECHO_TOKEN,
        status: "completed",
      }),
    );
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
    await verifyFollowUpTurn(t, parked.sessionId, "AP9-FOLLOW-UP-OK");
    t.succeeded();
  },
});
