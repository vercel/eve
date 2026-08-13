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
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * owner.approval.compound.settle-then-run: one delivery carrying an accepted response plus a message is
 * serialized — settlement, restored batch output, tool result, then the
 * message as ordinary turn input. Each part happens exactly once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.approval.compound.settle-then-run" },
  description:
    "owner.approval.compound.settle-then-run: compound response+message settles first, then runs the message.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-7".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const delivery = await sendCompoundDelivery(t, {
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      message: "After the tool result, reply with exactly AP7-COMPOUND-OK.",
    });
    const compound = delivery.turn;
    compound.expectOk();
    expectFollowUpSessionActive(compound, parked.sessionId);
    compound.eventsSatisfy(
      "one settlement and matching action result precede the message",
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
          { type: "message.received" },
        ]),
    );
    compound.messageIncludes(/AP7-COMPOUND-OK/i);
    compound.calledTool("guarded-echo", {
      input: { note: "ap-7" },
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      count: 1,
    });

    compound.succeeded();
    await verifyFollowUpTurn(delivery.session, parked.sessionId, "AP7-FOLLOW-UP-OK");
  },
});
