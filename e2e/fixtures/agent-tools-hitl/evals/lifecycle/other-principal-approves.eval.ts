import { defineEval } from "eve/evals";

import { respondAs, sendAs } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
  verifyFollowUpTurn,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

const A = "Bearer e2e-hitl-principal-a";
const B = "Bearer e2e-hitl-principal-b";
const RESPONDER_B = {
  authenticator: "e2e-hitl-bearer",
  issuer: "e2e",
  principalId: "e2e-hitl-b",
} as const;

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.approval.response.settle-allow-other-actor" },
  description:
    "owner.approval.response.settle-allow-other-actor: a second allowed principal settles another actor's approval.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(t, 'Call guarded-echo with note "principal-b-approve".', A);
    const request = t.requireInputRequest({
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const approved = await respondAs(t, { requestId: request.requestId, optionId: "approve" }, B);
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "principal B settles before the original action executes",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
          responder: RESPONDER_B,
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
    await verifyFollowUpTurn(t, parked.sessionId, "PRINCIPAL-B-APPROVE-FOLLOW-UP-OK");
  },
});
