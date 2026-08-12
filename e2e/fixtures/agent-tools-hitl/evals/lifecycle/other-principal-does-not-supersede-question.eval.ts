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
import { gateLifecycle } from "./shared";

const A = "Bearer e2e-hitl-principal-a";
const B = "Bearer e2e-hitl-principal-b";
const RESPONDER_A = {
  authenticator: "e2e-hitl-bearer",
  issuer: "e2e",
  principalId: "e2e-hitl-a",
} as const;

export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  metadata: { transition: "owner.question.message.run-open-other-actor" },
  description:
    "owner.question.message.run-open-other-actor: another principal's message leaves the originating actor's question open.",
  async test(t) {
    gateLifecycle(t);
    const parked = await sendAs(
      t,
      'Use ask_question exactly once to ask whether to use red or blue with option IDs "red" and "blue".',
      A,
    );
    const request = t.requireInputRequest({
      optionIds: ["red", "blue"],
      toolName: "ask_question",
    });
    const trace = traceRequest(parked.events, request);

    const message = await sendAs(
      t,
      "Do not answer the question. Call principal-marker once and include its marker.",
      B,
    );
    message.expectOk();
    expectFollowUpSessionActive(message, parked.sessionId);
    message.event("message.received", { count: 1 });
    message.event("message.completed", { count: 1 });
    message.eventsSatisfy("principal B leaves A's question open", (events) =>
      noRequestEvents(events, trace),
    );
    message.calledTool("principal-marker", {
      output: /PRINCIPALS current=user:e2e-hitl-b initiator=user:e2e-hitl-a/,
      count: 1,
    });
    message.messageIncludes("PRINCIPALS current=user:e2e-hitl-b initiator=user:e2e-hitl-a");

    const answered = await respondAs(t, { requestId: request.requestId, optionId: "red" }, A);
    answered.eventsSatisfy(
      "A's later answer closes only the original question",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "red",
          outcome: "answered",
          responder: RESPONDER_A,
        }) && exactRequestActionResult(events, trace, { status: "completed" }),
    );
    await verifyFollowUpTurn(t, parked.sessionId, "PRINCIPAL-B-QUESTION-FOLLOW-UP-OK");
  },
});
