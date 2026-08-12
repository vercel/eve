import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestExposure,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  noRequestEvents,
  requireRequest,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * owner.batch.response.settle-partial + owner.batch.close.fire-continuation: one assistant turn creates an approval and a question in the
 * same ApprovalBatch group. Settling one request leaves the batch
 * pending and runs nothing; settling the last request restores the stored
 * model output once and runs the approved tool exactly once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: {
    transitions: ["owner.batch.response.settle-partial", "owner.batch.close.fire-continuation"],
  },
  description:
    "owner.batch.response.settle-partial/owner.batch.close.fire-continuation: batch stays pending on partial settlement; last outcome closes it.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      'In one single turn, call the guarded-echo tool with note "b-1" AND use ask_question ' +
        'to ask me whether to continue, with exactly these options: id "yes", label "Yes"; ' +
        'id "no", label "No". Do both in the same response.',
    );
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = requireRequest(parked.inputRequests, {
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const question = requireRequest(parked.inputRequests, {
      optionIds: ["yes", "no"],
      toolName: "ask_question",
    });
    const approvalTrace = traceRequest(parked.events, approval);
    const questionTrace = traceRequest(parked.events, question);

    // owner.batch.response.settle-partial: settle only the approval; the batch stays open behind the question.
    const partial = await respondToRequests(t, {
      requestId: approval.requestId,
      optionId: "approve",
    });
    partial.expectOk();
    expectFollowUpSessionActive(partial, parked.sessionId);
    partial.eventsSatisfy(
      "approval settles without closing the batch",
      (events) =>
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: null,
        }) &&
        noRequestEvents(events, questionTrace) &&
        exactRequestActionResult(events, approvalTrace, null),
    );
    // owner.batch.close.fire-continuation: the last request closes the batch; the approved tool runs once.
    const closed = await respondToRequests(t, {
      requestId: question.requestId,
      optionId: "yes",
    });
    closed.expectOk();
    expectFollowUpSessionActive(closed, parked.sessionId);
    closed.eventsSatisfy(
      "the last response settles once before the approved call executes once",
      (events) =>
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
          responder: null,
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: questionTrace.requestId },
          { type: "action.result", actionCallId: approvalTrace.callId },
        ]),
    );
    t.eventsSatisfy(
      "each batch request has one terminal outcome and one allowed action result",
      (events) =>
        exactRequestExposure(events, approvalTrace) &&
        exactRequestExposure(events, questionTrace) &&
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: null,
        }) &&
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
          responder: null,
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }),
    );

    closed.succeeded();
    await verifyFollowUpTurn(t, parked.sessionId, "BATCH-FOLLOW-UP-OK");
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
