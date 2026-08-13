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
 * owner.batch.park.append: while an ApprovalBatch group is open, a later turn creates its own input
 * batch. Both stay independently addressable: closing the newer question
 * neither touches the older approval nor replays its batch; the approval
 * still settles and runs afterward.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.batch.park.append" },
  description:
    "owner.batch.park.append: later batches coexist with an older open ApprovalBatch group.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "b-4".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = t.requireInputRequest({
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const approvalTrace = traceRequest(parked.events, approval);

    // A later turn raises its own batch while the approval stays open.
    const questionTurn = await t.send(
      "Leave the pending approval alone. Use ask_question to ask whether to proceed with exactly " +
        'these options: id "yes", label "Yes"; id "no", label "No".',
    );
    questionTurn.expectOk();
    expectFollowUpSessionActive(questionTurn, parked.sessionId);
    const question = requireRequest(questionTurn.inputRequests, {
      optionIds: ["yes", "no"],
      toolName: "ask_question",
    });
    const questionTrace = traceRequest(questionTurn.events, question);

    // Closing the newer batch leaves the approval untouched.
    const answered = await respondToRequests(t, {
      requestId: question.requestId,
      optionId: "yes",
    });
    answered.expectOk();
    expectFollowUpSessionActive(answered, parked.sessionId);
    answered.eventsSatisfy(
      "the question closes once without touching or replaying the approval",
      (events) =>
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
          responder: null,
        }) &&
        noRequestEvents(events, approvalTrace) &&
        exactRequestActionResult(events, approvalTrace, null),
    );
    // The older ApprovalBatch group still closes and runs.
    const approved = await respondToRequests(t, {
      requestId: approval.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "the older approval closes and executes independently",
      (events) =>
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: null,
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactRequestActionResult(events, questionTrace, null) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: approvalTrace.requestId },
          { type: "action.result", actionCallId: approvalTrace.callId },
        ]),
    );
    t.eventsSatisfy(
      "both batches expose one request and one independent terminal outcome",
      (events) =>
        exactRequestExposure(events, approvalTrace) &&
        exactRequestExposure(events, questionTrace) &&
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
          responder: null,
        }) &&
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: null,
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactRequestActionResult(events, questionTrace, { status: "completed" }),
    );

    approved.succeeded();
    await verifyFollowUpTurn(t, parked.sessionId, "BATCHES-FOLLOW-UP-OK");
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
