import { defineEval } from "eve/evals";

import { respondAs, sendAs } from "./delivery";
import {
  exactRequestActionResult,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  noRequestEvents,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

const A = "Bearer e2e-hitl-principal-a";
const B = "Bearer e2e-hitl-principal-b";
const RESPONDER_A = {
  authenticator: "e2e-hitl-bearer",
  issuer: "e2e",
  principalId: "e2e-hitl-a",
} as const;

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.approval.message.run-open" },
  description:
    "owner.approval.message.run-open: another principal's message runs without touching the originating approval.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(t, 'Call guarded-echo with note "principal-b-message".', A);
    const request = t.requireInputRequest({
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const message = await sendAs(
      t,
      "Leave the approval open. Call principal-marker once and include only its marker.",
      B,
    );
    message.expectOk();
    expectFollowUpSessionActive(message, parked.sessionId);
    message.event("message.received", { count: 1 });
    message.event("message.completed", { count: 1 });
    message.eventsSatisfy(
      "principal B's message leaves A's approval open",
      (events) => noRequestEvents(events, trace) && exactRequestActionResult(events, trace, null),
    );
    message.calledTool("principal-marker", {
      output: /PRINCIPALS current=user:e2e-hitl-b initiator=user:e2e-hitl-a/,
      count: 1,
    });
    message.messageIncludes("PRINCIPALS current=user:e2e-hitl-b initiator=user:e2e-hitl-a");

    const approved = await respondAs(t, { requestId: request.requestId, optionId: "approve" }, A);
    approved.eventsSatisfy(
      "originating principal can still settle afterward",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: RESPONDER_A,
        }) &&
        exactRequestActionResult(events, trace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }),
    );
    await verifyFollowUpTurn(t, parked.sessionId, "PRINCIPAL-B-MESSAGE-FOLLOW-UP-OK");
  },
});
