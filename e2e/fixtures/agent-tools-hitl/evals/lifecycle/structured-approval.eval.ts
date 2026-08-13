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
const RESPONDER_A = {
  authenticator: "e2e-hitl-bearer",
  issuer: "e2e",
  principalId: "e2e-hitl-a",
} as const;

/**
 * owner.approval.response.settle-allow: an accepted Allow response from the originating actor settles the
 * approval, and the tool runs once when that settlement closes its
 * ApprovalBatch group.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.approval.response.settle-allow" },
  description:
    "owner.approval.response.settle-allow: structured approve settles the request and runs the tool once.",
  async test(t) {
    gateLifecycle(t);

    const parked = await sendAs(t, 'Call the guarded-echo tool with note "ap-1".', A);
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const approved = await respondAs(t, { requestId: request.requestId, optionId: "approve" }, A);
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "one allowed terminal precedes its one action result",
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
        }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: trace.requestId },
          { type: "action.result", actionCallId: trace.callId },
        ]),
    );
    approved.calledTool("guarded-echo", {
      input: { note: "ap-1" },
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      count: 1,
    });

    approved.succeeded();
    await verifyFollowUpTurn(t, parked.sessionId, "AP1-FOLLOW-UP-OK");
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
